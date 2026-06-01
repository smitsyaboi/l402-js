import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import { createL402Proxy } from '../src/proxy';
import type { LndConfig } from '../src/types';

// --- Test fixtures ---

const PREIMAGE_HEX = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const PAYMENT_HASH = crypto
  .createHash('sha256')
  .update(Buffer.from(PREIMAGE_HEX, 'hex'))
  .digest('hex');
const PAYMENT_HASH_B64 = Buffer.from(PAYMENT_HASH, 'hex').toString('base64');

const node: LndConfig = { restHost: 'https://localhost:8082', macaroon: 'deadbeef' };

function makeMacaroon(paymentHash: string, service = '/api/data') {
  return Buffer.from(
    JSON.stringify({ version: 1, paymentHash, service, issuedAt: Date.now() })
  ).toString('base64');
}

// Use raw http.request in tests so global fetch mocks (used for LND calls)
// don't intercept requests we make to the proxy itself.
function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, headers: res.headers, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Tests ---

describe('createL402Proxy', () => {
  let backend: http.Server;
  let proxy: http.Server;
  let backendPort: number;
  let proxyPort: number;

  beforeAll(async () => {
    // Minimal backend that just returns content
    const backendApp = express();
    backendApp.get('/api/data',  (_req, res) => res.json({ data: 'premium content' }));
    backendApp.get('/api/echo',  (req, res)  => res.json({ path: req.path }));

    backend = http.createServer(backendApp);
    await new Promise<void>((resolve) => backend.listen(0, resolve));
    backendPort = (backend.address() as AddressInfo).port;

    proxy = createL402Proxy({
      target: `http://localhost:${backendPort}`,
      price: 10,
      node,
    });
    await new Promise<void>((resolve) => proxy.listen(0, resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('unauthenticated requests', () => {
    it('returns 402 with invoice and macaroon', async () => {
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        json: async () => ({
          r_hash: PAYMENT_HASH_B64,
          payment_request: 'lnbcrt100n1proxy',
          add_index: '1',
        }),
      }));

      const result = await httpGet(proxyPort, '/api/data');

      expect(result.status).toBe(402);
      expect(result.body.code).toBe(402);
      expect(result.body.invoice).toBe('lnbcrt100n1proxy');
      expect(result.body.macaroon).toBeTruthy();
      expect(result.body.price).toBe(10);
    });

    it('includes WWW-Authenticate header in 402 response', async () => {
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        json: async () => ({
          r_hash: PAYMENT_HASH_B64,
          payment_request: 'lnbcrt100n1proxy',
          add_index: '1',
        }),
      }));

      const result = await httpGet(proxyPort, '/api/data');

      expect(result.headers['www-authenticate']).toMatch(/^L402 macaroon="/);
    });
  });

  describe('verified requests', () => {
    it('forwards to backend and returns backend response', async () => {
      const mac = makeMacaroon(PAYMENT_HASH);
      const result = await httpGet(proxyPort, '/api/data', {
        Authorization: `L402 ${mac}:${PREIMAGE_HEX}`,
      });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ data: 'premium content' });
    });

    it('forwards the correct path to the backend', async () => {
      const mac = makeMacaroon(PAYMENT_HASH, '/api/echo');
      const result = await httpGet(proxyPort, '/api/echo', {
        Authorization: `L402 ${mac}:${PREIMAGE_HEX}`,
      });

      expect(result.status).toBe(200);
      expect(result.body.path).toBe('/api/echo');
    });
  });

  describe('invalid tokens', () => {
    it('returns 401 for wrong preimage', async () => {
      const mac = makeMacaroon(PAYMENT_HASH);
      const wrongPreimage = 'deadbeef'.repeat(8);
      const result = await httpGet(proxyPort, '/api/data', {
        Authorization: `L402 ${mac}:${wrongPreimage}`,
      });

      expect(result.status).toBe(401);
      expect(result.body.error).toBe('Invalid L402 token');
    });

    it('returns 401 for malformed macaroon', async () => {
      const result = await httpGet(proxyPort, '/api/data', {
        Authorization: 'L402 notvalidbase64!!!:' + PREIMAGE_HEX,
      });

      expect(result.status).toBe(401);
    });
  });

  describe('backend errors', () => {
    it('returns 502 when backend is unreachable', async () => {
      // Port 1 is reserved and never open
      const deadProxy = createL402Proxy({ target: 'http://localhost:1', price: 10, node });
      await new Promise<void>((resolve) => deadProxy.listen(0, resolve));
      const deadPort = (deadProxy.address() as AddressInfo).port;

      try {
        const mac = makeMacaroon(PAYMENT_HASH);
        const result = await httpGet(deadPort, '/api/data', {
          Authorization: `L402 ${mac}:${PREIMAGE_HEX}`,
        });
        expect(result.status).toBe(502);
      } finally {
        await new Promise<void>((resolve) => deadProxy.close(() => resolve()));
      }
    });
  });

  describe('configuration', () => {
    it('uses custom description in the 402 challenge', async () => {
      const customProxy = createL402Proxy({
        target: `http://localhost:${backendPort}`,
        price: 50,
        description: 'Access to premium data feed',
        node,
      });
      await new Promise<void>((resolve) => customProxy.listen(0, resolve));
      const customPort = (customProxy.address() as AddressInfo).port;

      try {
        vi.stubGlobal('fetch', async () => ({
          ok: true,
          json: async () => ({
            r_hash: PAYMENT_HASH_B64,
            payment_request: 'lnbcrt500n1custom',
            add_index: '1',
          }),
        }));

        const result = await httpGet(customPort, '/api/data');

        expect(result.status).toBe(402);
        expect(result.body.price).toBe(50);
        expect(result.body.description).toBe('Access to premium data feed');
      } finally {
        await new Promise<void>((resolve) => customProxy.close(() => resolve()));
      }
    });

    it('supports dynamic pricing via priceFn', async () => {
      const dynamicProxy = createL402Proxy({
        target: `http://localhost:${backendPort}`,
        price: 1,
        priceFn: () => 99,
        node,
      });
      await new Promise<void>((resolve) => dynamicProxy.listen(0, resolve));
      const dynamicPort = (dynamicProxy.address() as AddressInfo).port;

      try {
        vi.stubGlobal('fetch', async () => ({
          ok: true,
          json: async () => ({
            r_hash: PAYMENT_HASH_B64,
            payment_request: 'lnbcrt990n1dynamic',
            add_index: '1',
          }),
        }));

        const result = await httpGet(dynamicPort, '/api/data');

        expect(result.status).toBe(402);
        expect(result.body.price).toBe(99);
      } finally {
        await new Promise<void>((resolve) => dynamicProxy.close(() => resolve()));
      }
    });
  });
});

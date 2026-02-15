import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { createL402Client } from '../src/client';
import type { LndConfig } from '../src/types';

// --- Test fixtures ---

const PREIMAGE_HEX = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const PREIMAGE_B64 = Buffer.from(PREIMAGE_HEX, 'hex').toString('base64');
const PAYMENT_HASH = crypto
  .createHash('sha256')
  .update(Buffer.from(PREIMAGE_HEX, 'hex'))
  .digest('hex');

const node: LndConfig = {
  restHost: 'https://localhost:8081',
  macaroon: 'deadbeef',
};

const MACAROON_B64 = Buffer.from(
  JSON.stringify({ version: 1, paymentHash: PAYMENT_HASH, service: '/api/test', issuedAt: Date.now() })
).toString('base64');

function make402Response() {
  return {
    status: 402,
    json: () =>
      Promise.resolve({
        code: 402,
        message: 'Payment Required',
        invoice: 'lnbc100n1fake_invoice',
        macaroon: MACAROON_B64,
        price: 100,
        description: 'L402 access',
      }),
  };
}

function make200Response(data: any = { result: 'ok' }) {
  return {
    status: 200,
    json: () => Promise.resolve(data),
  };
}

function makeLndPaymentResponse() {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        payment_error: '',
        payment_preimage: PREIMAGE_B64,
        payment_route: { total_fees: '0', total_amt: '100', hops: [] },
      }),
  };
}

// --- Tests ---

describe('createL402Client', () => {
  const savedTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (savedTlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsEnv;
    }
  });

  describe('non-402 responses', () => {
    it('returns data directly without paying', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(make200Response({ hello: 'world' }))
      );

      const client = createL402Client({ node });
      const result = await client.fetch('https://api.example.com/free');

      expect(result.data).toEqual({ hello: 'world' });
      expect(result.paid).toBe(false);
      expect(result.price).toBeUndefined();
      expect(result.preimage).toBeUndefined();
    });
  });

  describe('402 auto-payment flow', () => {
    it('detects 402, pays invoice, and retries with L402 token', async () => {
      const fetchMock = vi
        .fn()
        // First call: target API returns 402
        .mockResolvedValueOnce(make402Response())
        // Second call: LND payment
        .mockResolvedValueOnce(makeLndPaymentResponse())
        // Third call: retry with auth header
        .mockResolvedValueOnce(make200Response({ joke: 'funny' }));

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });
      const result = await client.fetch('https://api.example.com/joke');

      expect(result.data).toEqual({ joke: 'funny' });
      expect(result.paid).toBe(true);
      expect(result.price).toBe(100);
      expect(result.preimage).toBe(PREIMAGE_HEX);

      // Verify the retry included the L402 authorization header
      const retryCall = fetchMock.mock.calls[2];
      const retryHeaders = retryCall[1].headers;
      expect(retryHeaders.Authorization).toMatch(/^L402 .+:.+$/);
    });

    it('sends payment to the correct LND endpoint', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response());

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });
      await client.fetch('https://api.example.com/test');

      // Second call should be to LND
      const lndCall = fetchMock.mock.calls[1];
      expect(lndCall[0]).toBe('https://localhost:8081/v1/channels/transactions');
      expect(lndCall[1].method).toBe('POST');
      expect(lndCall[1].headers['Grpc-Metadata-macaroon']).toBe('deadbeef');

      const lndBody = JSON.parse(lndCall[1].body);
      expect(lndBody.payment_request).toBe('lnbc100n1fake_invoice');
    });
  });

  describe('safety limits', () => {
    it('rejects prices above maxAutoPaySats', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 402,
        json: () =>
          Promise.resolve({
            code: 402,
            invoice: 'lnbc10000n1expensive',
            macaroon: MACAROON_B64,
            price: 50000,
            description: 'Expensive',
          }),
      }));

      const client = createL402Client({ node, maxAutoPaySats: 1000 });

      await expect(
        client.fetch('https://api.example.com/expensive')
      ).rejects.toThrow(/exceeds maxAutoPaySats/);
    });

    it('defaults maxAutoPaySats to 10000', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 402,
        json: () =>
          Promise.resolve({
            code: 402,
            invoice: 'lnbc_over_limit',
            macaroon: MACAROON_B64,
            price: 10001,
            description: 'Over default limit',
          }),
      }));

      const client = createL402Client({ node });

      await expect(
        client.fetch('https://api.example.com/test')
      ).rejects.toThrow(/exceeds maxAutoPaySats/);
    });

    it('allows prices at or below the limit', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          status: 402,
          json: () =>
            Promise.resolve({
              code: 402,
              invoice: 'lnbc_at_limit',
              macaroon: MACAROON_B64,
              price: 1000,
              description: 'At limit',
            }),
        })
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response());

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node, maxAutoPaySats: 1000 });
      const result = await client.fetch('https://api.example.com/test');

      expect(result.paid).toBe(true);
    });
  });

  describe('token caching', () => {
    it('caches tokens and reuses them on subsequent requests', async () => {
      const fetchMock = vi
        .fn()
        // First request: 402 -> pay -> success
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response({ first: true }))
        // Second request: uses cached token, gets 200 directly
        .mockResolvedValueOnce(make200Response({ second: true }));

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });

      const r1 = await client.fetch('https://api.example.com/joke');
      expect(r1.paid).toBe(true);

      const r2 = await client.fetch('https://api.example.com/joke');
      expect(r2.data).toEqual({ second: true });

      // Second request should include the cached auth header
      const secondReqHeaders = fetchMock.mock.calls[3][1].headers;
      expect(secondReqHeaders.Authorization).toMatch(/^L402 /);

      // Only 4 total fetch calls (not 6) — no second payment
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('tracks cache size correctly', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response());

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });
      expect(client.cacheSize()).toBe(0);

      await client.fetch('https://api.example.com/test');
      expect(client.cacheSize()).toBe(1);
    });

    it('clears cache when requested', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response());

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });
      await client.fetch('https://api.example.com/test');
      expect(client.cacheSize()).toBe(1);

      client.clearCache();
      expect(client.cacheSize()).toBe(0);
    });
  });

  describe('payment errors', () => {
    it('throws when LND returns a payment error', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              payment_error: 'insufficient_balance',
              payment_preimage: '',
              payment_route: null,
            }),
        });

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });

      await expect(
        client.fetch('https://api.example.com/test')
      ).rejects.toThrow(/insufficient_balance/);
    });

    it('throws when LND REST call fails', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node });

      await expect(
        client.fetch('https://api.example.com/test')
      ).rejects.toThrow(/LND payment failed/);
    });
  });

  describe('request forwarding', () => {
    it('forwards custom headers and options', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(make200Response())
      );

      const client = createL402Client({ node });
      await client.fetch('https://api.example.com/test', {
        method: 'POST',
        headers: { 'X-Custom': 'value' },
        body: JSON.stringify({ data: 1 }),
      });

      const call = vi.mocked(fetch).mock.calls[0];
      expect(call[1]?.method).toBe('POST');
      expect((call[1]?.headers as any)['X-Custom']).toBe('value');
      expect(call[1]?.body).toBe('{"data":1}');
    });
  });

  describe('TLS scoping', () => {
    it('does not set NODE_TLS_REJECT_UNAUTHORIZED globally on construction', () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      createL402Client({ node: { ...node, skipTlsVerify: true } });

      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });

    it('restores NODE_TLS_REJECT_UNAUTHORIZED after LND payment call', async () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(make402Response())
        .mockResolvedValueOnce(makeLndPaymentResponse())
        .mockResolvedValueOnce(make200Response());

      vi.stubGlobal('fetch', fetchMock);

      const client = createL402Client({ node: { ...node, skipTlsVerify: true } });
      await client.fetch('https://api.example.com/test');

      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });
  });
});

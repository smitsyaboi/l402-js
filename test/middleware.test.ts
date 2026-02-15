import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { l402 } from '../src/middleware';
import type { LndConfig } from '../src/types';

// --- Test fixtures ---

// Known preimage/hash pair for deterministic tests
const PREIMAGE_HEX = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const PAYMENT_HASH = crypto
  .createHash('sha256')
  .update(Buffer.from(PREIMAGE_HEX, 'hex'))
  .digest('hex');
const PAYMENT_HASH_B64 = Buffer.from(PAYMENT_HASH, 'hex').toString('base64');

const node: LndConfig = {
  restHost: 'https://localhost:8082',
  macaroon: 'deadbeef',
};

function makeMacaroon(paymentHash: string, service = '/api/test') {
  return Buffer.from(
    JSON.stringify({ version: 1, paymentHash, service, issuedAt: Date.now() })
  ).toString('base64');
}

// --- Express req/res mocks ---

function mockReq(overrides: Record<string, any> = {}) {
  return {
    headers: {},
    method: 'GET',
    path: '/api/test',
    ...overrides,
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(key: string, value: string) {
      res.headers[key] = value;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// --- Tests ---

describe('l402 middleware', () => {
  const savedTlsEnv = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore TLS env to its original state after each test
    if (savedTlsEnv === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsEnv;
    }
  });

  describe('402 challenge (no auth header)', () => {
    it('returns 402 with invoice and macaroon', async () => {
      // Mock LND invoice creation
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc100n1fake_invoice',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({ node, price: 100 });
      const req = mockReq();
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(402);
      expect(res.body.code).toBe(402);
      expect(res.body.message).toBe('Payment Required');
      expect(res.body.invoice).toBe('lnbc100n1fake_invoice');
      expect(res.body.price).toBe(100);
      expect(res.body.macaroon).toBeTruthy();
      expect(res.headers['WWW-Authenticate']).toContain('L402');
      expect(res.headers['WWW-Authenticate']).toContain('lnbc100n1fake_invoice');
    });

    it('uses custom description in memo', async () => {
      let capturedBody: any;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation((_url: string, opts: any) => {
          capturedBody = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                r_hash: PAYMENT_HASH_B64,
                payment_request: 'lnbc100n1test',
                add_index: '1',
              }),
          });
        })
      );

      const middleware = l402({ node, price: 50, description: 'Buy a joke' });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      expect(capturedBody.memo).toBe('Buy a joke');
      expect(capturedBody.value).toBe('50');
    });

    it('supports dynamic pricing via priceFn', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc200n1test',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({
        node,
        price: 10,
        priceFn: () => 200,
      });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      expect(res.body.price).toBe(200);
    });

    it('supports async priceFn', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc300n1test',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({
        node,
        price: 10,
        priceFn: async () => 300,
      });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      expect(res.body.price).toBe(300);
    });
  });

  describe('L402 verification (valid auth)', () => {
    it('calls next() with valid preimage', async () => {
      const macaroon = makeMacaroon(PAYMENT_HASH);
      const authHeader = `L402 ${macaroon}:${PREIMAGE_HEX}`;

      const middleware = l402({ node, price: 100 });
      const req = mockReq({ headers: { authorization: authHeader } });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(req.l402).toEqual({
        paid: true,
        preimage: PREIMAGE_HEX,
        paymentHash: PAYMENT_HASH,
        service: '/api/test',
      });
    });

    it('is case-insensitive for the L402 prefix', async () => {
      const macaroon = makeMacaroon(PAYMENT_HASH);
      const authHeader = `l402 ${macaroon}:${PREIMAGE_HEX}`;

      const middleware = l402({ node, price: 100 });
      const req = mockReq({ headers: { authorization: authHeader } });
      const next = vi.fn();

      await middleware(req, mockRes(), next);

      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe('L402 rejection (invalid auth)', () => {
    it('returns 401 for wrong preimage', async () => {
      const macaroon = makeMacaroon(PAYMENT_HASH);
      const wrongPreimage = '0000000000000000000000000000000000000000000000000000000000000000';
      const authHeader = `L402 ${macaroon}:${wrongPreimage}`;

      const middleware = l402({ node, price: 100 });
      const req = mockReq({ headers: { authorization: authHeader } });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('Invalid L402 token');
    });

    it('returns 401 for malformed macaroon', async () => {
      const authHeader = `L402 not-valid-base64:${PREIMAGE_HEX}`;

      const middleware = l402({ node, price: 100 });
      const req = mockReq({ headers: { authorization: authHeader } });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when token has no colon separator', async () => {
      const authHeader = `L402 sometokenwithoutcolon`;

      const middleware = l402({ node, price: 100 });
      const req = mockReq({ headers: { authorization: authHeader } });
      const res = mockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });

  describe('error handling', () => {
    it('returns 500 when LND is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
      );

      const middleware = l402({ node, price: 100 });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });

    it('returns 500 when LND returns an error status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
        })
      );

      const middleware = l402({ node, price: 100 });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });
  });

  describe('TLS scoping', () => {
    it('does not set NODE_TLS_REJECT_UNAUTHORIZED globally on construction', () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      l402({ node: { ...node, skipTlsVerify: true }, price: 100 });

      // The env var should NOT have been set at construction time
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });

    it('restores NODE_TLS_REJECT_UNAUTHORIZED after LND call with skipTlsVerify', async () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc100n1test',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({ node: { ...node, skipTlsVerify: true }, price: 100 });
      await middleware(mockReq(), mockRes(), vi.fn());

      // After the call completes, the env var should be cleaned up
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });

    it('does not touch NODE_TLS_REJECT_UNAUTHORIZED when skipTlsVerify is false', async () => {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc100n1test',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({ node, price: 100 });
      await middleware(mockReq(), mockRes(), vi.fn());

      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    });
  });

  describe('price validation', () => {
    it('returns 500 for price of 0', async () => {
      const middleware = l402({ node, price: 0 });
      const res = mockRes();
      await middleware(mockReq(), res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });

    it('returns 500 for negative price', async () => {
      const middleware = l402({ node, price: -10 });
      const res = mockRes();
      await middleware(mockReq(), res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });

    it('returns 500 for NaN price from priceFn', async () => {
      const middleware = l402({ node, price: 100, priceFn: () => NaN });
      const res = mockRes();
      await middleware(mockReq(), res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });

    it('returns 500 for Infinity price from priceFn', async () => {
      const middleware = l402({ node, price: 100, priceFn: () => Infinity });
      const res = mockRes();
      await middleware(mockReq(), res, vi.fn());

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe('Payment gateway error');
    });
  });

  describe('macaroon round-trip', () => {
    it('embeds payment hash that matches the invoice', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc100n1test',
              add_index: '1',
            }),
        })
      );

      const middleware = l402({ node, price: 100 });
      const req = mockReq();
      const res = mockRes();

      await middleware(req, res, vi.fn());

      // Decode the macaroon from the response and verify it contains the right hash
      const macaroonData = JSON.parse(
        Buffer.from(res.body.macaroon, 'base64').toString()
      );
      expect(macaroonData.version).toBe(1);
      expect(macaroonData.paymentHash).toBe(PAYMENT_HASH);
      expect(macaroonData.service).toBe('/api/test');
    });

    it('produces a macaroon that can be verified with the correct preimage', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              r_hash: PAYMENT_HASH_B64,
              payment_request: 'lnbc100n1test',
              add_index: '1',
            }),
        })
      );

      // Step 1: Get the 402 challenge
      const middleware = l402({ node, price: 100 });
      const challengeReq = mockReq();
      const challengeRes = mockRes();
      await middleware(challengeReq, challengeRes, vi.fn());

      // Step 2: Use the macaroon + correct preimage to authenticate
      const authHeader = `L402 ${challengeRes.body.macaroon}:${PREIMAGE_HEX}`;
      const authReq = mockReq({ headers: { authorization: authHeader } });
      const authRes = mockRes();
      const next = vi.fn();
      await middleware(authReq, authRes, next);

      expect(next).toHaveBeenCalledOnce();
      expect(authReq.l402.paid).toBe(true);
    });
  });
});

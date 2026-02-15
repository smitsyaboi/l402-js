// src/middleware.ts
// L402 Express middleware — paywall any route with Lightning
//
// Usage:
//   import { l402 } from 'l402-js';
//
//   app.get('/api/data', l402({ node, price: 100 }), (req, res) => {
//     res.json({ data: 'premium content' });
//   });

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { L402MiddlewareConfig, LndInvoiceResponse } from './types';

/**
 * Create a service macaroon that embeds the payment hash.
 * This ties the macaroon to a specific Lightning invoice.
 *
 * In the L402 spec, macaroons are the authentication token.
 * The payment hash inside links it to the Lightning payment.
 * When the client pays and gets the preimage, they can prove
 * payment by showing that sha256(preimage) === paymentHash.
 */
function createServiceMacaroon(
  paymentHash: string,
  service: string
): string {
  const macaroonData = {
    version: 1,
    paymentHash,
    service,
    issuedAt: Date.now(),
  };
  return Buffer.from(JSON.stringify(macaroonData)).toString('base64');
}

/**
 * Parse a base64-encoded service macaroon back into data.
 */
function parseServiceMacaroon(
  macaroonBase64: string
): { version: number; paymentHash: string; service: string; issuedAt: number } | null {
  try {
    const data = JSON.parse(
      Buffer.from(macaroonBase64, 'base64').toString()
    );
    if (data.version && data.paymentHash) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify that a preimage hashes to the expected payment hash.
 * This is the core cryptographic check of the L402 protocol.
 *
 * The Lightning Network works on hash-timelock contracts:
 *   payment_hash = sha256(preimage)
 *
 * Only someone who paid the invoice can know the preimage,
 * so if sha256(preimage) === payment_hash, payment is proven.
 * No database lookup needed. Pure math.
 */
function verifyPreimage(preimage: string, paymentHash: string): boolean {
  const hash = crypto
    .createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return hash === paymentHash;
}

/**
 * Create a Lightning invoice via the LND REST API.
 */
async function createInvoice(
  restHost: string,
  macaroon: string,
  amount: number,
  memo: string
): Promise<LndInvoiceResponse> {
  const res = await fetch(`${restHost}/v1/invoices`, {
    method: 'POST',
    headers: {
      'Grpc-Metadata-macaroon': macaroon,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      value: amount.toString(),
      memo,
    }),
  });

  if (!res.ok) {
    throw new Error(`LND invoice creation failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<LndInvoiceResponse>;
}

/**
 * L402 Express middleware.
 *
 * Protects a route with Lightning payments using the L402 protocol.
 * When a client hits a protected route without authorization:
 *   1. Server creates a Lightning invoice
 *   2. Server responds with HTTP 402 + invoice + macaroon
 *   3. Client pays the invoice, gets a preimage
 *   4. Client retries with Authorization: L402 <macaroon>:<preimage>
 *   5. Server verifies preimage cryptographically — no DB needed
 *   6. Request proceeds to your handler
 *
 * @example
 * ```typescript
 * const node = {
 *   restHost: 'https://127.0.0.1:8082',
 *   macaroon: '0201036c6e64...',
 * };
 *
 * // Paywall a single route
 * app.get('/api/premium', l402({ node, price: 100 }), handler);
 *
 * // Dynamic pricing
 * app.post('/api/compute', l402({
 *   node,
 *   price: 50,
 *   priceFn: (req) => req.body.complexity * 10,
 * }), handler);
 * ```
 */
export function l402(config: L402MiddlewareConfig) {
  const { node, price, description, priceFn } = config;

  // Handle self-signed TLS certs in development
  if (node.skipTlsVerify) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // --- Check for existing L402 authorization ---
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.toLowerCase().startsWith('l402 ')) {
      const token = authHeader.slice(5);
      const colonIndex = token.lastIndexOf(':');

      if (colonIndex > 0) {
        const macaroonB64 = token.slice(0, colonIndex);
        const preimage = token.slice(colonIndex + 1);
        const macaroonData = parseServiceMacaroon(macaroonB64);

        if (
          macaroonData &&
          verifyPreimage(preimage, macaroonData.paymentHash)
        ) {
          // Cryptographically verified — payment is proven
          (req as any).l402 = {
            paid: true,
            preimage,
            paymentHash: macaroonData.paymentHash,
            service: macaroonData.service,
          };
          return next();
        }
      }

      // Auth header present but invalid
      res.status(401).json({ error: 'Invalid L402 token' });
      return;
    }

    // --- No auth: issue a 402 challenge ---
    try {
      // Determine price (static or dynamic)
      const finalPrice = priceFn ? await priceFn(req) : price;
      const memo = description || `L402 access: ${req.method} ${req.path}`;

      // Create Lightning invoice
      const invoice = await createInvoice(
        node.restHost,
        node.macaroon,
        finalPrice,
        memo
      );

      // Extract payment hash as hex
      const paymentHashHex = Buffer.from(
        invoice.r_hash,
        'base64'
      ).toString('hex');

      // Create service macaroon embedding the payment hash
      const serviceMacaroon = createServiceMacaroon(
        paymentHashHex,
        req.path
      );

      // Respond with 402 Payment Required
      res.status(402);
      res.setHeader(
        'WWW-Authenticate',
        `L402 macaroon="${serviceMacaroon}", invoice="${invoice.payment_request}"`
      );
      res.json({
        code: 402,
        message: 'Payment Required',
        invoice: invoice.payment_request,
        macaroon: serviceMacaroon,
        price: finalPrice,
        description: memo,
      });
    } catch (err: any) {
      console.error('L402 middleware error:', err.message);
      res.status(500).json({ error: 'Payment gateway error' });
    }
  };
}

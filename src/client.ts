// src/client.ts
// L402 client — a drop-in replacement for fetch() that pays invoices
//
// Usage:
//   import { createL402Client } from 'l402-js';
//
//   const client = createL402Client({ node });
//   const data = await client.fetch('https://api.example.com/data');
//   // That's it. If the server returns 402, the client pays and retries.

import { L402ClientConfig, L402Challenge, LndPaymentResponse } from './types';
import { lndFetch } from './lnd-fetch';

interface L402FetchResult<T = any> {
  data: T;
  paid: boolean;
  price?: number;
  preimage?: string;
}

/**
 * Pay a Lightning invoice via the LND REST API.
 * Returns the preimage as proof of payment.
 */
async function payInvoice(
  restHost: string,
  macaroon: string,
  paymentRequest: string,
  skipTlsVerify?: boolean
): Promise<LndPaymentResponse> {
  const res = await lndFetch(
    `${restHost}/v1/channels/transactions`,
    {
      method: 'POST',
      headers: {
        'Grpc-Metadata-macaroon': macaroon,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payment_request: paymentRequest }),
    },
    skipTlsVerify
  );

  if (!res.ok) {
    throw new Error(`LND payment failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<LndPaymentResponse>;
}

/**
 * Create an L402-aware HTTP client.
 *
 * Returns an object with a `fetch` method that works like regular fetch,
 * but automatically handles L402 payment challenges:
 *
 *   1. Makes the request
 *   2. If server returns 402, extracts the invoice and macaroon
 *   3. Pays the Lightning invoice through your LND node
 *   4. Retries the request with the L402 authorization header
 *   5. Returns the final response
 *
 * @example
 * ```typescript
 * const client = createL402Client({
 *   node: {
 *     restHost: 'https://127.0.0.1:8081',
 *     macaroon: '0201036c6e64...',
 *     skipTlsVerify: true,
 *   },
 *   maxAutoPaySats: 1000, // safety limit
 * });
 *
 * // Just like fetch, but it pays for you
 * const joke = await client.fetch('https://api.example.com/joke');
 * console.log(joke.data);       // { joke: '...' }
 * console.log(joke.paid);       // true
 * console.log(joke.price);      // 10
 * console.log(joke.preimage);   // 'a1b2c3...'
 * ```
 */
export function createL402Client(config: L402ClientConfig) {
  const { node, maxAutoPaySats = 10000 } = config;

  // Cache tokens: URL -> L402 authorization header
  // Reuse tokens for subsequent requests to the same endpoint
  const tokenCache = new Map<string, string>();

  async function l402Fetch<T = any>(
    url: string,
    options: RequestInit = {}
  ): Promise<L402FetchResult<T>> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    // Check if we have a cached token for this URL
    const cachedToken = tokenCache.get(url);
    if (cachedToken) {
      headers['Authorization'] = cachedToken;
    }

    // Make the request
    const res = await fetch(url, { ...options, headers });

    // Not a 402 — return normally
    if (res.status !== 402) {
      const data = await res.json() as T;
      return { data, paid: false };
    }

    // --- Handle 402 Payment Required ---
    const challenge = (await res.json()) as L402Challenge;

    // Safety check: don't auto-pay more than the configured limit
    if (challenge.price > maxAutoPaySats) {
      throw new Error(
        `L402 price (${challenge.price} sats) exceeds maxAutoPaySats (${maxAutoPaySats}). ` +
          `Increase the limit or pay manually.`
      );
    }

    // Pay the Lightning invoice
    const payment = await payInvoice(
      node.restHost,
      node.macaroon,
      challenge.invoice,
      node.skipTlsVerify
    );

    if (payment.payment_error) {
      throw new Error(`Lightning payment failed: ${payment.payment_error}`);
    }

    // Convert preimage from base64 to hex
    const preimageHex = Buffer.from(
      payment.payment_preimage,
      'base64'
    ).toString('hex');

    // Build the L402 authorization token
    const l402Token = `L402 ${challenge.macaroon}:${preimageHex}`;

    // Cache it for future requests to this URL
    tokenCache.set(url, l402Token);

    // Retry the request with authorization
    const authedRes = await fetch(url, {
      ...options,
      headers: {
        ...headers,
        Authorization: l402Token,
      },
    });

    const data = (await authedRes.json()) as T;

    return {
      data,
      paid: true,
      price: challenge.price,
      preimage: preimageHex,
    };
  }

  return {
    fetch: l402Fetch,

    /** Clear cached L402 tokens */
    clearCache: () => tokenCache.clear(),

    /** Check how many tokens are cached */
    cacheSize: () => tokenCache.size,
  };
}

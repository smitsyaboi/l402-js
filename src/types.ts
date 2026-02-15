// src/types.ts
// Core types for the L402 protocol implementation

import { Request } from 'express';

/**
 * Configuration for connecting to an LND node.
 * This is the only setup a developer needs to provide.
 */
export interface LndConfig {
  /** LND REST API host, e.g. 'https://127.0.0.1:8082' */
  restHost: string;
  /** Admin macaroon in hex format */
  macaroon: string;
  /** Skip TLS verification (for self-signed certs in dev) */
  skipTlsVerify?: boolean;
}

/**
 * Configuration for the L402 middleware.
 * Controls pricing and behavior per route.
 */
export interface L402MiddlewareConfig {
  /** LND node connection */
  node: LndConfig;
  /** Price in satoshis for this endpoint */
  price: number;
  /** Human-readable description shown to the client */
  description?: string;
  /** Custom function to determine price dynamically */
  priceFn?: (req: Request) => number | Promise<number>;
}

/**
 * Configuration for the L402 client.
 */
export interface L402ClientConfig {
  /** LND node connection (for paying invoices) */
  node: LndConfig;
  /** Maximum price in sats the client will auto-pay (safety limit) */
  maxAutoPaySats?: number;
}

/**
 * The 402 challenge returned by the server.
 */
export interface L402Challenge {
  code: 402;
  message: string;
  invoice: string;
  macaroon: string;
  price: number;
  description: string;
}

/**
 * Proof of payment attached to authenticated requests.
 * Available on `req.l402` after middleware verification.
 */
export interface L402Proof {
  paid: true;
  preimage: string;
  paymentHash: string;
  service: string;
}

/**
 * Extended Express Request with L402 proof.
 */
export interface L402Request extends Request {
  l402?: L402Proof;
}

/**
 * LND invoice creation response (subset of fields we use).
 */
export interface LndInvoiceResponse {
  r_hash: string;
  payment_request: string;
  add_index: string;
}

/**
 * LND payment response (subset of fields we use).
 */
export interface LndPaymentResponse {
  payment_error: string;
  payment_preimage: string;
  payment_route: {
    total_fees: string;
    total_amt: string;
    hops: Array<{
      pub_key: string;
      fee: string;
    }>;
  };
}

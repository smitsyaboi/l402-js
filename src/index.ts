// src/index.ts
// l402-js — Lightning L402 protocol for Express and Node.js
//
// Middleware: Paywall any Express route with Lightning payments
//   import { l402 } from 'l402-js';
//   app.get('/api/data', l402({ node, price: 100 }), handler);
//
// Client: Drop-in fetch that auto-pays L402 invoices
//   import { createL402Client } from 'l402-js';
//   const client = createL402Client({ node });
//   const { data } = await client.fetch('https://api.example.com/data');
//
// Proxy: Paywall any existing HTTP backend with zero backend changes
//   import { createL402Proxy } from 'l402-js';
//   createL402Proxy({ target: 'http://localhost:3000', price: 10, node }).listen(8402);
//
// CLI: npx l402-proxy --target http://localhost:3000 --price 10 --lnd-host ... --macaroon ...

export { l402 } from './middleware';
export { createL402Client } from './client';
export { createL402Proxy } from './proxy';
export type {
  LndConfig,
  L402MiddlewareConfig,
  L402ClientConfig,
  L402Challenge,
  L402Proof,
  L402Request,
} from './types';
export type { L402ProxyConfig } from './proxy';

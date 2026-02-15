// src/index.ts
// l402-js — Lightning L402 protocol for Express and Node.js
//
// Server: Paywall any Express route with Lightning payments
// Client: Drop-in fetch that auto-pays L402 invoices
//
// npm install l402-js
//
// Server:
//   import { l402 } from 'l402-js';
//   app.get('/api/data', l402({ node, price: 100 }), handler);
//
// Client:
//   import { createL402Client } from 'l402-js';
//   const client = createL402Client({ node });
//   const { data } = await client.fetch('https://api.example.com/data');

export { l402 } from './middleware';
export { createL402Client } from './client';
export type {
  LndConfig,
  L402MiddlewareConfig,
  L402ClientConfig,
  L402Challenge,
  L402Proof,
  L402Request,
} from './types';

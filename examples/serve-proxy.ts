// examples/serve-proxy.ts
// Starts mock LND + backend + proxy on fixed ports and stays running.
// Use this to manually test with curl or any HTTP client.
//
// Run:  npx ts-node examples/serve-proxy.ts
//
// Then in another terminal:
//   curl -s http://localhost:8402/api/weather | jq .
//   curl -s http://localhost:8402/api/stocks  | jq .

import http from 'http';
import express from 'express';
import { createL402Proxy } from '../src/proxy';
import type { LndConfig } from '../src/types';

// Fixed preimage for the demo — mock LND always returns this.
// Use it to build a valid Authorization header manually:
//   L402 <macaroon-from-402-body>:c0ffee00c0ffee00...
export const DEMO_PREIMAGE =
  'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

import crypto from 'crypto';
const PAYMENT_HASH_B64 = Buffer.from(
  crypto.createHash('sha256').update(Buffer.from(DEMO_PREIMAGE, 'hex')).digest('hex'),
  'hex'
).toString('base64');
const PREIMAGE_B64 = Buffer.from(DEMO_PREIMAGE, 'hex').toString('base64');

// ── Mock LND  (port 18082) ────────────────────────────────────────────────────

const lndApp = express();
lndApp.use(express.json());

lndApp.post('/v1/invoices', (req, res) => {
  console.log(`[mock-lnd]  create invoice  ${req.body.value} sats`);
  res.json({ r_hash: PAYMENT_HASH_B64, payment_request: 'lnbcrt100n1demo', add_index: '1' });
});

lndApp.post('/v1/channels/transactions', (_req, res) => {
  console.log(`[mock-lnd]  pay invoice → returning preimage`);
  res.json({ payment_error: '', payment_preimage: PREIMAGE_B64, payment_route: {} });
});

// ── Demo backend  (port 13000) ────────────────────────────────────────────────

const backendApp = express();

backendApp.get('/api/weather', (_req, res) => {
  console.log('[backend]   GET /api/weather');
  res.json({ temperature: 72, condition: 'sunny', forecast: '5-day outlook: clear' });
});

backendApp.get('/api/stocks', (_req, res) => {
  console.log('[backend]   GET /api/stocks');
  res.json({ BTCUSD: 95_000, ETHUSD: 3_200, timestamp: new Date().toISOString() });
});

// ── Start everything ──────────────────────────────────────────────────────────

const LND_PORT     = 18082;
const BACKEND_PORT = 13000;
const PROXY_PORT   = 8402;

http.createServer(lndApp).listen(LND_PORT);
http.createServer(backendApp).listen(BACKEND_PORT);

const node: LndConfig = {
  restHost: `http://localhost:${LND_PORT}`,
  macaroon: '0201deadbeef',
};

createL402Proxy({
  target:      `http://localhost:${BACKEND_PORT}`,
  price:       10,
  description: 'Premium data — 10 sats',
  node,
}).listen(PROXY_PORT, () => {
  console.log('\n  L402 Proxy — servers running\n');
  console.log(`  Mock LND  → http://localhost:${LND_PORT}`);
  console.log(`  Backend   → http://localhost:${BACKEND_PORT}`);
  console.log(`  Proxy     → http://localhost:${PROXY_PORT}\n`);
  console.log('  Demo preimage (use this to build a valid auth token):');
  console.log(`  ${DEMO_PREIMAGE}\n`);
  console.log('  Ctrl+C to stop\n');
});

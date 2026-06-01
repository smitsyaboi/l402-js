// examples/demo-proxy.ts
// Self-contained L402 proxy demo. No real LND node needed.
//
// Run:  npx ts-node examples/demo-proxy.ts
//
// What runs:
//   1. Mock LND server   — handles invoice creation + payment
//   2. Demo backend      — serves "premium" data
//   3. L402 proxy        — gates the backend behind Lightning
//   4. L402 client       — auto-pays and fetches

import http from 'http';
import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { createL402Proxy } from '../src/proxy';
import { createL402Client } from '../src/client';
import type { LndConfig } from '../src/types';

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  gray:   '\x1b[90m',
};

function line(label: string, colour: string, msg: string) {
  const tag = `${colour}${c.bold}[${label}]${c.reset}`;
  console.log(`  ${tag} ${msg}`);
}

function header(title: string) {
  console.log(`\n${c.bold}${c.cyan}  ${title}${c.reset}`);
  console.log(`  ${c.gray}${'─'.repeat(50)}${c.reset}\n`);
}

// ── Fixed preimage/hash pair for the demo ─────────────────────────────────────
// In production the LND node generates these. Here we hard-code them
// so the mock LND can return a valid preimage that satisfies the crypto check.

const PREIMAGE_HEX = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
const PREIMAGE_B64 = Buffer.from(PREIMAGE_HEX, 'hex').toString('base64');
const PAYMENT_HASH_HEX = crypto
  .createHash('sha256')
  .update(Buffer.from(PREIMAGE_HEX, 'hex'))
  .digest('hex');
const PAYMENT_HASH_B64 = Buffer.from(PAYMENT_HASH_HEX, 'hex').toString('base64');

// ── Mock LND server ───────────────────────────────────────────────────────────
// Stands in for a real LND node. Handles the two REST endpoints the library uses.

async function startMockLnd(): Promise<{ server: http.Server; port: number }> {
  const app = express();
  app.use(express.json());

  // Middleware creates invoices via this endpoint
  app.post('/v1/invoices', (req, res) => {
    line('mock-lnd', c.gray, `create invoice  ${req.body.value} sats  "${req.body.memo}"`);
    res.json({
      r_hash:           PAYMENT_HASH_B64,
      payment_request:  'lnbcrt100n1p3xnhl2pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfq',
      add_index:        '1',
    });
  });

  // Client pays invoices via this endpoint
  app.post('/v1/channels/transactions', (req, res) => {
    const bolt11 = (req.body.payment_request as string).slice(0, 24);
    line('mock-lnd', c.gray, `pay invoice     ${bolt11}...`);
    res.json({
      payment_error:    '',
      payment_preimage: PREIMAGE_B64,
      payment_route:    { total_fees: '0', total_amt: '10', hops: [] },
    });
  });

  return listen(http.createServer(app));
}

// ── Demo backend ──────────────────────────────────────────────────────────────
// Any existing HTTP service. Zero L402 awareness required.

async function startBackend(): Promise<{ server: http.Server; port: number }> {
  const app = express();

  app.get('/api/weather', (_req, res) => {
    line('backend', c.blue, 'served /api/weather');
    res.json({ temperature: 72, condition: 'sunny', forecast: '5-day outlook: clear' });
  });

  app.get('/api/stocks', (_req, res) => {
    line('backend', c.blue, 'served /api/stocks');
    res.json({ BTCUSD: 95_000, ETHUSD: 3_200, timestamp: new Date().toISOString() });
  });

  return listen(http.createServer(app));
}

// ── Utility ───────────────────────────────────────────────────────────────────

function listen(server: http.Server): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, port: (server.address() as AddressInfo).port }))
  );
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── Main demo ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}${c.cyan}  L402 Reverse Proxy — End-to-End Demo${c.reset}`);
  console.log(`  ${c.gray}${'─'.repeat(50)}${c.reset}`);

  // Start all three servers
  const lnd     = await startMockLnd();
  const backend = await startBackend();

  const node: LndConfig = {
    restHost:      `http://localhost:${lnd.port}`,
    macaroon:      '0201deadbeef',
    skipTlsVerify: false,
  };

  const proxy = createL402Proxy({
    target:      `http://localhost:${backend.port}`,
    price:       10,
    description: 'Premium data — 10 sats per request',
    node,
  });
  const { port: proxyPort } = await listen(proxy);

  line('demo', c.green, `Mock LND  → http://localhost:${lnd.port}`);
  line('demo', c.green, `Backend   → http://localhost:${backend.port}`);
  line('demo', c.green, `Proxy     → http://localhost:${proxyPort}  (10 sats/req)`);

  // Create an L402 client (represents the AI agent or API consumer)
  const client = createL402Client({ node, maxAutoPaySats: 1_000 });

  // ── Request 1: First call — triggers payment ──────────────────────────────

  header('Request 1  GET /api/weather  (first time — will pay)');

  const r1 = await client.fetch<{ temperature: number; condition: string; forecast: string }>(
    `http://localhost:${proxyPort}/api/weather`
  );

  line('client', c.yellow, `paid=${r1.paid}  price=${r1.price} sats`);
  line('client', c.yellow, `preimage=${r1.preimage?.slice(0, 20)}...`);
  line('client', c.green,  `data=${JSON.stringify(r1.data)}`);

  // ── Request 2: Same URL — reuses cached token ─────────────────────────────

  header('Request 2  GET /api/weather  (same URL — cached token, no payment)');

  const r2 = await client.fetch<{ temperature: number; condition: string; forecast: string }>(
    `http://localhost:${proxyPort}/api/weather`
  );

  line('client', c.yellow, `paid=${r2.paid}  (token cache hit — no LND call, no invoice)`);
  line('client', c.green,  `data=${JSON.stringify(r2.data)}`);

  // ── Request 3: New endpoint — pays for a different route ──────────────────

  header('Request 3  GET /api/stocks  (new URL — pays again)');

  const r3 = await client.fetch<{ BTCUSD: number; ETHUSD: number }>(
    `http://localhost:${proxyPort}/api/stocks`
  );

  line('client', c.yellow, `paid=${r3.paid}  price=${r3.price} sats`);
  line('client', c.green,  `data=${JSON.stringify(r3.data)}`);

  // ── Summary ───────────────────────────────────────────────────────────────

  header('Summary');
  console.log(`  ${c.gray}Backend code changes required:  0`);
  console.log(`  Lightning payments made:        2  (3 requests, 1 cached)`);
  console.log(`  Total spent:                    20 sats`);
  console.log(`  Token cache size:               ${client.cacheSize()} entries${c.reset}\n`);

  await Promise.all([close(lnd.server), close(backend.server), close(proxy)]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

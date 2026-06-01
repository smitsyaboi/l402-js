# l402-js

Lightning L402 protocol for Express and Node.js. Paywall any API with Bitcoin micropayments in three lines of code.

```
npm install l402-js
```

## What is L402?

L402 uses the HTTP `402 Payment Required` status code to create pay-per-request APIs. When a client hits a protected endpoint, the server returns a Lightning invoice. The client pays, gets a cryptographic proof (preimage), and retries with that proof. No accounts, no API keys, no credit cards.

This is how AI agents will pay for services.

---

## Server — Paywall any Express route

### With LND

```typescript
import express from 'express';
import { l402 } from 'l402-js';

const app = express();

app.get('/api/data', l402({
  node: {
    restHost: 'https://127.0.0.1:8082',
    macaroon: process.env.LND_MACAROON!,
    skipTlsVerify: true, // dev only
  },
  price: 100,
}), (req, res) => {
  res.json({ secret: 'You paid 100 sats for this.' });
});

app.listen(3000);
```

### With Alby Hub or any NWC wallet

No LND node required. Use any [NWC-compatible wallet](https://nwc.getalby.com) (Alby Hub, Zeus, etc.):

```typescript
app.get('/api/data', l402({
  nwc: { connectionString: process.env.NWC_CONNECTION_STRING! },
  price: 100,
}), handler);
```

Any request without a valid L402 token gets a `402` response with a Lightning invoice. Pay the invoice, retry with the proof, get the data.

---

## Client — Auto-pay L402 invoices

```typescript
import { createL402Client } from 'l402-js';

const client = createL402Client({
  node: {
    restHost: 'https://127.0.0.1:8081',
    macaroon: process.env.LND_MACAROON!,
  },
  maxAutoPaySats: 1000, // safety limit
});

const result = await client.fetch('https://api.example.com/data');
console.log(result.data);      // { secret: 'You paid 100 sats for this.' }
console.log(result.paid);      // true
console.log(result.price);     // 100
console.log(result.preimage);  // 'a1b2c3d4...'
```

`client.fetch` works like regular `fetch` but automatically detects 402 responses, pays the Lightning invoice, and retries with proof. Tokens are cached per URL.

---

## Proxy — Paywall any existing HTTP backend

Zero changes to your backend. Point the proxy at it and every request requires a Lightning payment:

```typescript
import { createL402Proxy } from 'l402-js';

createL402Proxy({
  target: 'http://localhost:3000',
  price: 10,
  node: { restHost: '...', macaroon: '...' },
  // or: nwc: { connectionString: '...' }
}).listen(8402);
```

Or use the CLI binary — no code required:

```bash
npx l402-proxy \
  --target http://localhost:3000 \
  --price 10 \
  --lnd-host https://127.0.0.1:8082 \
  --macaroon <hex>
```

---

## Dynamic Pricing

```typescript
app.post('/api/compute', l402({
  node,
  price: 50,                              // fallback
  priceFn: (req) => req.body.tokens * 2, // 2 sats per token
}), handler);
```

---

## How It Works

```
Client                          Server                         Wallet
  |                                |                              |
  |  GET /api/data                 |                              |
  |------------------------------->|                              |
  |                                |  Create invoice (100 sats)   |
  |                                |----------------------------->|
  |                                |  invoice + payment_hash      |
  |                                |<-----------------------------|
  |  402 + invoice + macaroon      |                              |
  |<-------------------------------|                              |
  |                                                               |
  |  Pay invoice                                                  |
  |-------------------------------------------------------------->|
  |  preimage (proof of payment)                                  |
  |<--------------------------------------------------------------|
  |                                                               |
  |  GET /api/data                 |                              |
  |  Authorization: L402 mac:pre   |                              |
  |------------------------------->|                              |
  |                                |  sha256(preimage) == hash?   |
  |                                |  ✓ Verified (pure math)      |
  |  200 + data                    |                              |
  |<-------------------------------|                              |
```

Verification is **cryptographic, not database-driven**. The server checks `sha256(preimage) === payment_hash` — pure math, no payment lookups, no server-side state.

---

## API Reference

### `l402(config)` — middleware

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `node` | `LndConfig` | One of node/nwc | LND REST API connection |
| `nwc` | `NwcConfig` | One of node/nwc | NWC wallet connection |
| `price` | `number` | ✓ | Price in satoshis |
| `description` | `string` | | Human-readable description shown in 402 |
| `priceFn` | `(req) => number \| Promise<number>` | | Dynamic pricing (overrides price) |

### `createL402Client(config)` — auto-paying client

| Option | Type | Description |
|--------|------|-------------|
| `node` | `LndConfig` | LND connection for paying invoices |
| `maxAutoPaySats` | `number` | Max auto-pay limit in sats (default: 10000) |

Returns `{ fetch, clearCache, cacheSize }`.

### `createL402Proxy(config)` — reverse proxy

| Option | Type | Description |
|--------|------|-------------|
| `target` | `string` | Backend URL to proxy to |
| `node` | `LndConfig` | LND connection |
| `nwc` | `NwcConfig` | NWC connection |
| `price` | `number` | Price per request in sats |
| `description` | `string` | Description shown in 402 challenge |
| `priceFn` | `(req) => number` | Dynamic pricing |

### `LndConfig`

| Field | Type | Description |
|-------|------|-------------|
| `restHost` | `string` | LND REST API URL, e.g. `https://127.0.0.1:8082` |
| `macaroon` | `string` | Admin macaroon in hex |
| `skipTlsVerify` | `boolean` | Skip TLS verification — dev only |

### `NwcConfig`

| Field | Type | Description |
|-------|------|-------------|
| `connectionString` | `string` | `nostr+walletconnect://` connection string from your NWC wallet |

---

## Development

```bash
git clone https://github.com/smitsyaboi/l402-js
cd l402-js && npm install
npm test
```

## License

MIT

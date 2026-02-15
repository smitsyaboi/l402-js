# l402-js

Lightning L402 protocol for Express and Node.js. Paywall any API with Bitcoin micropayments in three lines of code.

```
npm install l402-js
```

## What is L402?

L402 uses the HTTP `402 Payment Required` status code to create pay-per-request APIs. When a client hits a protected endpoint, the server returns a Lightning invoice. The client pays, gets a cryptographic proof (preimage), and retries with that proof. No accounts, no API keys, no credit cards.

This is how AI agents will pay for services. See [Lightning Labs' announcement](https://lightning.engineering/posts/2026-02-11-ln-agent-tools/) for context.

## Server — Paywall any Express route

```typescript
import express from 'express';
import { l402 } from 'l402-js';

const app = express();

const node = {
  restHost: 'https://127.0.0.1:8082',
  macaroon: process.env.LND_MACAROON!,
  skipTlsVerify: true, // dev only
};

// This route now requires a Lightning payment of 100 sats
app.get('/api/data', l402({ node, price: 100 }), (req, res) => {
  res.json({ secret: 'You paid 100 sats for this.' });
});

app.listen(3000);
```

That's it. Any request without a valid L402 token gets a `402` response with a Lightning invoice. Pay the invoice, retry with the proof, get the data.

## Client — Auto-pay L402 invoices

```typescript
import { createL402Client } from 'l402-js';

const client = createL402Client({
  node: {
    restHost: 'https://127.0.0.1:8081',
    macaroon: process.env.LND_MACAROON!,
    skipTlsVerify: true,
  },
  maxAutoPaySats: 1000, // safety limit
});

const result = await client.fetch('https://api.example.com/data');
console.log(result.data);      // { secret: 'You paid 100 sats for this.' }
console.log(result.paid);      // true
console.log(result.price);     // 100
console.log(result.preimage);  // 'a1b2c3d4...'
```

`client.fetch` works like regular `fetch`, but automatically detects 402 responses, pays the Lightning invoice, and retries with proof. Tokens are cached for reuse.

## Dynamic Pricing

Price requests based on content, user, or complexity:

```typescript
app.post('/api/compute', l402({
  node,
  price: 50, // fallback
  priceFn: (req) => req.body.tokens * 2, // 2 sats per token
}), handler);
```

## How It Works

```
Client                          Server                         LND Node
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

The key insight: verification is **cryptographic, not database-driven**. The server checks `sha256(preimage) === payment_hash` — if it matches, payment is mathematically proven. No server-side state. No payment lookups. This is what makes L402 work for distributed systems and AI agents.

## For AI Agent Developers

L402 is the emerging standard for machine-to-machine payments. This package gives your agents the ability to:

- **Sell services**: Wrap your agent's capabilities in an Express API, paywall it with `l402()`, and any other agent can pay to use it.
- **Buy services**: Use `createL402Client` to give your agent a wallet that auto-pays for resources it discovers.
- **Interoperate**: Compatible with Lightning Labs' [lightning-agent-tools](https://github.com/lightninglabs/lightning-agent-tools) and the broader L402 ecosystem.

## API Reference

### `l402(config)`

Express middleware that paywalls a route.

| Option | Type | Description |
|--------|------|-------------|
| `node` | `LndConfig` | LND connection (restHost, macaroon) |
| `price` | `number` | Price in satoshis |
| `description` | `string?` | Human-readable description |
| `priceFn` | `(req) => number` | Dynamic pricing function |

### `createL402Client(config)`

Creates an L402-aware HTTP client.

| Option | Type | Description |
|--------|------|-------------|
| `node` | `LndConfig` | LND connection for paying invoices |
| `maxAutoPaySats` | `number?` | Max auto-pay amount (default: 10000) |

Returns `{ fetch, clearCache, cacheSize }`.

### `LndConfig`

| Field | Type | Description |
|-------|------|-------------|
| `restHost` | `string` | LND REST API URL |
| `macaroon` | `string` | Admin macaroon (hex) |
| `skipTlsVerify` | `boolean?` | Skip TLS verification (dev only) |

## Development

```bash
# Clone and install
git clone https://github.com/joshuatrees/l402-js
cd l402-js && npm install

# Use Polar (https://lightningpolar.com) for local Lightning Network
# Start a network with 2+ LND nodes

# Run the example server
npm run dev:server

# Run the example client (separate terminal)
npm run dev:client
```

## License

MIT

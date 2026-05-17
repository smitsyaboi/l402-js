#!/usr/bin/env node
// src/proxy-cli.ts
// CLI entry point for l402-proxy binary.
// Compiled to dist/proxy-cli.js and registered in package.json "bin".

import { createL402Proxy } from './proxy';

function usage(): never {
  console.error(`
l402-proxy — Paywall any HTTP API with Lightning payments

Usage:
  l402-proxy --target <url> --price <sats> --lnd-host <url> --macaroon <hex> [options]

Required:
  --target      Backend URL to proxy to        (or L402_TARGET env var)
  --price       Price per request in satoshis  (or L402_PRICE env var)
  --lnd-host    LND REST API host URL          (or LND_REST_HOST env var)
  --macaroon    LND admin macaroon hex         (or LND_MACAROON env var)

Options:
  --port        Proxy listen port [8402]       (or L402_PORT env var)
  --skip-tls    Skip TLS verification [false]  (or LND_SKIP_TLS=true env var)
  --description Human-readable description     (or L402_DESCRIPTION env var)

Example:
  l402-proxy --target http://localhost:3000 --price 10 --port 8402 \\
             --lnd-host https://127.0.0.1:8080 --macaroon 0201036c6e64...
`);
  process.exit(1);
}

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
}

const args = parseArgs();

const target      = args['target']      ?? process.env['L402_TARGET'];
const lndHost     = args['lnd-host']    ?? process.env['LND_REST_HOST'];
const macaroon    = args['macaroon']    ?? process.env['LND_MACAROON'];
const priceRaw    = args['price']       ?? process.env['L402_PRICE'];
const portRaw     = args['port']        ?? process.env['L402_PORT'] ?? '8402';
const skipTls     = (args['skip-tls']   ?? process.env['LND_SKIP_TLS']) === 'true';
const description = args['description'] ?? process.env['L402_DESCRIPTION'];

if (!target || !lndHost || !macaroon || !priceRaw) {
  usage();
}

const price = parseInt(priceRaw!, 10);
const port  = parseInt(portRaw,   10);

if (!Number.isFinite(price) || price <= 0) {
  console.error(`Error: --price must be a positive integer (got: ${priceRaw})`);
  process.exit(1);
}

if (!Number.isFinite(port) || port < 1 || port > 65535) {
  console.error(`Error: --port must be a valid port number (got: ${portRaw})`);
  process.exit(1);
}

const server = createL402Proxy({
  target: target!,
  price,
  description,
  node: {
    restHost:      lndHost!,
    macaroon:      macaroon!,
    skipTlsVerify: skipTls,
  },
});

server.listen(port, () => {
  console.log(`[l402-proxy] Listening on http://0.0.0.0:${port}`);
  console.log(`[l402-proxy] → ${target}`);
  console.log(`[l402-proxy] Price: ${price} sats per request`);
  if (description) console.log(`[l402-proxy] Description: ${description}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[l402-proxy] Port ${port} is already in use`);
  } else {
    console.error('[l402-proxy] Server error:', err.message);
  }
  process.exit(1);
});

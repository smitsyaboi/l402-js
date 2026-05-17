// src/proxy.ts
// Standalone L402 reverse proxy — paywall any existing HTTP backend with Lightning.
//
// Usage (programmatic):
//   const server = createL402Proxy({ target: 'http://localhost:3000', price: 10, node });
//   server.listen(8402);
//
// Usage (CLI):
//   npx l402-proxy --target http://localhost:3000 --price 10 --lnd-host ... --macaroon ...

import http from 'http';
import https from 'https';
import express from 'express';
import { l402 } from './middleware';
import type { LndConfig } from './types';

export interface L402ProxyConfig {
  /** Backend URL to proxy verified requests to, e.g. 'http://localhost:3000' */
  target: string;
  /** LND node used to create invoices */
  node: LndConfig;
  /** Price in satoshis charged per request */
  price: number;
  /** Human-readable description shown in the 402 challenge */
  description?: string;
  /** Optional per-request dynamic pricing (overrides price) */
  priceFn?: (req: express.Request) => number | Promise<number>;
}

// Headers that must not be forwarded between a proxy and upstream/downstream.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/**
 * Create an HTTP server that acts as an L402-gated reverse proxy.
 *
 * Every inbound request is checked for a valid L402 authorization token.
 * Unverified requests receive a 402 Payment Required response with a
 * Lightning invoice. Once the client pays and retries with the preimage,
 * the request is forwarded to the configured backend transparently.
 *
 * The backend requires zero code changes — point the proxy at it and done.
 */
export function createL402Proxy(config: L402ProxyConfig): http.Server {
  const { target, node, price, description, priceFn } = config;
  const targetUrl = new URL(target);
  const transport = targetUrl.protocol === 'https:' ? https : http;

  const app = express();

  // Gate all routes behind L402 payment verification
  app.use(l402({ node, price, description, priceFn }));

  // Forward every verified request to the backend, streaming the response back
  app.use((req: express.Request, res: express.Response) => {
    const port = targetUrl.port
      ? parseInt(targetUrl.port, 10)
      : targetUrl.protocol === 'https:' ? 443 : 80;

    // Strip hop-by-hop headers; set correct Host for the backend
    const forwardHeaders: http.OutgoingHttpHeaders = { host: targetUrl.host };
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }

    const proxyReq = transport.request(
      { hostname: targetUrl.hostname, port, path: req.url, method: req.method, headers: forwardHeaders },
      (proxyRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        }
        res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
        proxyRes.pipe(res, { end: true });
      }
    );

    proxyReq.on('error', (err) => {
      console.error('[l402-proxy] Backend error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
      }
    });

    // Pipe the request body to the backend (no-op for bodyless methods)
    req.pipe(proxyReq, { end: true });
  });

  return http.createServer(app);
}

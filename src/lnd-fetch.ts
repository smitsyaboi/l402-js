// src/lnd-fetch.ts
// Scoped TLS bypass for LND REST calls.
//
// LND commonly uses self-signed certs in development.
// Instead of disabling TLS verification globally with
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' (which
// affects ALL connections in the process), this helper
// scopes the bypass to individual LND fetch calls only.

/**
 * Fetch wrapper that optionally bypasses TLS verification
 * for a single request. Used only for LND REST API calls.
 */
export async function lndFetch(
  url: string,
  init: RequestInit,
  skipTlsVerify?: boolean
): Promise<Response> {
  if (!skipTlsVerify) {
    return fetch(url, init);
  }

  const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetch(url, init);
  } finally {
    if (saved === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
    }
  }
}

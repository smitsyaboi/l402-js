// src/lnd.rs — HTTP client factory for LND REST calls
// Equivalent to src/lnd-fetch.ts
//
// The TypeScript version scoped TLS bypass by temporarily mutating
// process.env.NODE_TLS_REJECT_UNAUTHORIZED, then restoring it.
// Rust is cleaner: configure TLS per-client — no global state, no race conditions.

use reqwest::{Client, ClientBuilder};

/// Build an HTTP client for LND REST calls.
/// When skip_tls_verify is true, accepts self-signed certificates.
pub fn lnd_client(skip_tls_verify: bool) -> Client {
    let builder = ClientBuilder::new();
    let builder = if skip_tls_verify {
        builder.danger_accept_invalid_certs(true)
    } else {
        builder
    };
    builder.build().expect("failed to build LND HTTP client")
}

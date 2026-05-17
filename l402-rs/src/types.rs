// src/types.rs — core types for the L402 protocol
// Direct equivalent of src/types.ts

use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};

// ── Configuration ─────────────────────────────────────────────────────────────

/// Connection config for an LND node. Equivalent to `LndConfig` in TypeScript.
/// Clone-able because it is shared across many concurrent requests via Axum state.
#[derive(Clone, Debug)]
pub struct LndConfig {
    /// LND REST API host, e.g. "https://127.0.0.1:8082"
    pub rest_host: String,
    /// Admin macaroon in hex format
    pub macaroon: String,
    /// Skip TLS verification — dev only, for self-signed certs
    pub skip_tls_verify: bool,
}

/// Dynamic pricing function type.
/// Equivalent to `priceFn?: (req: Request) => number | Promise<number>`.
/// Must be Send + Sync because Axum shares state across async threads.
pub type PriceFn = Arc<
    dyn Fn(
            &axum::http::Request<axum::body::Body>,
        ) -> Pin<Box<dyn Future<Output = Result<u64, String>> + Send>>
        + Send
        + Sync,
>;

/// Middleware configuration — equivalent to `L402MiddlewareConfig`.
#[derive(Clone)]
pub struct L402MiddlewareConfig {
    pub node: LndConfig,
    /// Static price in satoshis (used when price_fn is None)
    pub price: u64,
    /// Human-readable description shown in the 402 challenge
    pub description: Option<String>,
    /// Optional per-request pricing function (takes priority over price)
    pub price_fn: Option<PriceFn>,
}

/// Client configuration — equivalent to `L402ClientConfig`.
#[derive(Clone, Debug)]
pub struct L402ClientConfig {
    pub node: LndConfig,
    /// Maximum price the client will auto-pay in sats. Defaults to 10_000.
    pub max_auto_pay_sats: Option<u64>,
}

// ── Protocol messages ─────────────────────────────────────────────────────────

/// The HTTP 402 response body — equivalent to `L402Challenge`.
#[derive(Debug, Serialize, Deserialize)]
pub struct L402Challenge {
    pub code: u16,
    pub message: String,
    pub invoice: String,   // BOLT11 payment request
    pub macaroon: String,  // base64-encoded service token
    pub price: u64,
    pub description: String,
}

/// Proof of payment attached to a verified request — equivalent to `L402Proof`.
/// Axum handlers retrieve this via `Extension<L402Proof>`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct L402Proof {
    pub paid: bool,
    pub preimage: String,      // hex
    pub payment_hash: String,  // hex
    pub service: String,       // route path, e.g. "/api/data"
}

// ── Internal macaroon structure ───────────────────────────────────────────────

/// Encoded as base64(JSON) — same wire format as the TypeScript implementation
/// so tokens issued by one are accepted by the other.
#[derive(Serialize, Deserialize)]
pub(crate) struct ServiceMacaroon {
    pub version: u8,
    pub payment_hash: String,
    pub service: String,
    pub issued_at: u64,
}

// ── LND REST response shapes ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub(crate) struct LndInvoiceResponse {
    pub r_hash: String,           // base64-encoded payment hash
    pub payment_request: String,  // BOLT11
    #[allow(dead_code)]
    pub add_index: String,
}

#[derive(Deserialize)]
pub(crate) struct LndPaymentResponse {
    pub payment_error: String,
    pub payment_preimage: String,  // base64-encoded preimage
}

// ── Client return type ────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct L402FetchResult<T> {
    pub data: T,
    pub paid: bool,
    pub price: Option<u64>,
    pub preimage: Option<String>,
}

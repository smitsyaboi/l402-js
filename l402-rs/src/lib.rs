// l402 — Lightning L402 protocol for Axum
//
// Server: Paywall any Axum route with Lightning payments
//   let app = Router::new()
//       .route("/api/data", get(handler))
//       .route_layer(middleware::from_fn_with_state(config, l402_middleware));
//
// Client: Auto-paying HTTP client
//   let client = L402Client::new(config);
//   let result = client.fetch::<MyData>("https://api.example.com/data").await?;
//
// Proxy: Zero-change paywall for any existing HTTP backend
//   let app = l402_proxy(ProxyConfig { target, price: 10, node });

pub mod client;
pub mod middleware;
pub mod proxy;
pub mod types;
pub(crate) mod lnd;

pub use client::L402Client;
pub use middleware::l402_middleware;
pub use proxy::{l402_proxy, ProxyConfig};
pub use types::{L402Challenge, L402ClientConfig, L402MiddlewareConfig, L402Proof, LndConfig};

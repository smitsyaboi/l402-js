// src/proxy.rs — L402 reverse proxy
// Equivalent to src/proxy.ts
//
// Usage:
//   let app = l402_proxy(ProxyConfig {
//       target: "http://localhost:3000".to_string(),
//       price:  10,
//       node,
//       description: None,
//       price_fn:    None,
//   });
//   let listener = TcpListener::bind("0.0.0.0:8402").await?;
//   axum::serve(listener, app).await?;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use std::sync::Arc;

use crate::{
    l402_middleware,
    types::{L402MiddlewareConfig, LndConfig, PriceFn},
};

/// Configuration for the L402 reverse proxy.
#[derive(Clone)]
pub struct ProxyConfig {
    /// Backend to proxy verified requests to, e.g. "http://localhost:3000"
    pub target: String,
    pub node: LndConfig,
    /// Price in satoshis charged per request
    pub price: u64,
    pub description: Option<String>,
    pub price_fn: Option<PriceFn>,
}

/// Build an Axum Router that acts as an L402-gated reverse proxy.
///
/// Every inbound request is checked for a valid L402 token.
/// Unverified requests get a 402 + Lightning invoice.
/// Verified requests are forwarded to the target backend.
/// The backend requires zero code changes.
pub fn l402_proxy(config: ProxyConfig) -> Router {
    let middleware_config = L402MiddlewareConfig {
        node:        config.node.clone(),
        price:       config.price,
        description: config.description.clone(),
        price_fn:    config.price_fn.clone(),
    };

    let target = Arc::new(config.target.clone());

    Router::new()
        .route("/", any(proxy_handler))
        .route("/*path", any(proxy_handler))
        .with_state(target)
        .route_layer(middleware::from_fn_with_state(
            middleware_config,
            l402_middleware,
        ))
}

// ── Proxy handler ─────────────────────────────────────────────────────────────

async fn proxy_handler(
    State(target): State<Arc<String>>,
    req: Request<Body>,
) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let upstream_url = format!("{}{}", target, path_and_query);

    // Build a reqwest request from the Axum request
    let client = reqwest::Client::new();
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);

    let mut upstream_req = client.request(method, &upstream_url);

    // Forward headers, skip hop-by-hop
    for (name, value) in req.headers() {
        let lower = name.as_str().to_lowercase();
        if !is_hop_by_hop(&lower) {
            upstream_req = upstream_req.header(name.as_str(), value);
        }
    }

    // Forward body
    let body_bytes = axum::body::to_bytes(req.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    upstream_req = upstream_req.body(body_bytes);

    match upstream_req.send().await {
        Ok(upstream_res) => {
            let status = StatusCode::from_u16(upstream_res.status().as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);

            let mut builder = axum::http::Response::builder().status(status);

            for (name, value) in upstream_res.headers() {
                if !is_hop_by_hop(name.as_str()) {
                    builder = builder.header(name.as_str(), value);
                }
            }

            let body = upstream_res.bytes().await.unwrap_or_default();
            builder.body(Body::from(body)).unwrap().into_response()
        }
        Err(e) => {
            eprintln!("[l402-proxy] Backend error: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                axum::Json(serde_json::json!({ "error": "Bad Gateway", "message": e.to_string() })),
            )
                .into_response()
        }
    }
}

fn is_hop_by_hop(header: &str) -> bool {
    matches!(
        header,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use sha2::{Digest, Sha256};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use tower::ServiceExt;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    const PREIMAGE_HEX: &str =
        "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233";

    fn payment_hash_hex() -> String {
        hex::encode(Sha256::digest(hex::decode(PREIMAGE_HEX).unwrap()))
    }

    fn payment_hash_b64() -> String {
        BASE64.encode(hex::decode(payment_hash_hex()).unwrap())
    }

    fn make_macaroon(payment_hash: &str, service: &str) -> String {
        BASE64.encode(
            serde_json::json!({
                "version": 1, "payment_hash": payment_hash,
                "service": service, "issued_at": 0u64,
            })
            .to_string(),
        )
    }

    fn test_proxy(lnd_url: String, backend_url: String) -> Router {
        l402_proxy(ProxyConfig {
            target:      backend_url,
            price:       10,
            description: None,
            price_fn:    None,
            node: LndConfig {
                rest_host:       lnd_url,
                macaroon:        "deadbeef".into(),
                skip_tls_verify: false,
            },
        })
    }

    #[tokio::test]
    async fn unauthenticated_request_returns_402() {
        let lnd = MockServer::start().await;
        let backend = MockServer::start().await;

        Mock::given(method("POST")).and(path("/v1/invoices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "r_hash": payment_hash_b64(),
                "payment_request": "lnbcrt100n1proxy",
                "add_index": "1",
            })))
            .mount(&lnd).await;

        let res = test_proxy(lnd.uri(), backend.uri())
            .oneshot(Request::get("/api/data").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::PAYMENT_REQUIRED);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap(),
        ).unwrap();
        assert_eq!(body["invoice"], "lnbcrt100n1proxy");
    }

    #[tokio::test]
    async fn verified_request_is_forwarded_to_backend() {
        let lnd = MockServer::start().await;
        let backend = MockServer::start().await;

        Mock::given(method("GET")).and(path("/api/data"))
            .respond_with(ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({ "data": "premium content" })))
            .mount(&backend).await;

        let mac = make_macaroon(&payment_hash_hex(), "/api/data");
        let token = format!("L402 {}:{}", mac, PREIMAGE_HEX);

        let res = test_proxy(lnd.uri(), backend.uri())
            .oneshot(
                Request::get("/api/data")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap(),
        ).unwrap();
        assert_eq!(body["data"], "premium content");
    }

    #[tokio::test]
    async fn wrong_preimage_returns_401() {
        let lnd = MockServer::start().await;
        let backend = MockServer::start().await;

        let mac = make_macaroon(&payment_hash_hex(), "/api/data");
        let token = format!("L402 {}:{}", mac, "deadbeef".repeat(8));

        let res = test_proxy(lnd.uri(), backend.uri())
            .oneshot(
                Request::get("/api/data")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn backend_error_returns_502() {
        let lnd = MockServer::start().await;

        let mac = make_macaroon(&payment_hash_hex(), "/api/data");
        let token = format!("L402 {}:{}", mac, PREIMAGE_HEX);

        // Port 1 is reserved and never open
        let res = test_proxy(lnd.uri(), "http://localhost:1".to_string())
            .oneshot(
                Request::get("/api/data")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }
}

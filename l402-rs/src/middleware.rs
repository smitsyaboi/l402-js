// src/middleware.rs — L402 Axum middleware
// Equivalent to src/middleware.ts
//
// Usage:
//   let app = Router::new()
//       .route("/api/data", get(handler))
//       .route_layer(middleware::from_fn_with_state(config, l402_middleware));
//
//   // In your handler, retrieve proof of payment:
//   async fn handler(Extension(proof): Extension<L402Proof>) -> impl IntoResponse { ... }

use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{
    lnd::lnd_client,
    types::{L402MiddlewareConfig, L402Proof, LndInvoiceResponse, ServiceMacaroon},
};

// ── Macaroon helpers ──────────────────────────────────────────────────────────

fn create_service_macaroon(payment_hash: &str, service: &str) -> String {
    let m = ServiceMacaroon {
        version: 1,
        payment_hash: payment_hash.to_string(),
        service: service.to_string(),
        issued_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs(),
    };
    BASE64.encode(serde_json::to_string(&m).unwrap())
}

fn parse_service_macaroon(macaroon_b64: &str) -> Option<ServiceMacaroon> {
    let bytes = BASE64.decode(macaroon_b64).ok()?;
    let s = String::from_utf8(bytes).ok()?;
    let m: ServiceMacaroon = serde_json::from_str(&s).ok()?;
    if m.payment_hash.is_empty() {
        return None;
    }
    Some(m)
}

// ── Cryptographic core ────────────────────────────────────────────────────────

/// sha256(hex_decode(preimage_hex)) == payment_hash_hex
///
/// This is the entire security guarantee of L402.
/// The Lightning Network issues preimages only upon successful payment,
/// so possessing a valid preimage is cryptographic proof of payment.
/// No database lookup needed — pure math.
fn verify_preimage(preimage_hex: &str, payment_hash_hex: &str) -> bool {
    let Ok(bytes) = hex::decode(preimage_hex) else {
        return false;
    };
    hex::encode(Sha256::digest(bytes)) == payment_hash_hex
}

// ── LND invoice creation ──────────────────────────────────────────────────────

async fn create_invoice(
    node: &crate::types::LndConfig,
    amount: u64,
    memo: &str,
) -> Result<LndInvoiceResponse, String> {
    let client = lnd_client(node.skip_tls_verify);
    let res = client
        .post(format!("{}/v1/invoices", node.rest_host))
        .header("Grpc-Metadata-macaroon", &node.macaroon)
        .json(&serde_json::json!({
            "value": amount.to_string(),
            "memo":  memo,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("LND invoice creation failed: {}", res.status()));
    }

    res.json::<LndInvoiceResponse>()
        .await
        .map_err(|e| e.to_string())
}

// ── Middleware ────────────────────────────────────────────────────────────────

/// L402 Axum middleware. Protects a route with Lightning payments.
///
/// On every request:
///   1. If `Authorization: L402 <macaroon>:<preimage>` is present and valid,
///      attach `L402Proof` to request extensions and call next.
///   2. If the header is present but invalid, return 401.
///   3. If absent, create a Lightning invoice and return 402.
pub async fn l402_middleware(
    State(config): State<L402MiddlewareConfig>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    // ── Check for existing L402 authorization ─────────────────────────────

    // Extract into an owned String first so the immutable borrow on req.headers()
    // is released before we call req.extensions_mut() further below.
    let auth_header: Option<String> = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(auth_str) = auth_header {
        if auth_str.to_lowercase().starts_with("l402 ") {
            let token = &auth_str[5..];

            if let Some(colon) = token.rfind(':') {
                let macaroon_b64 = &token[..colon];
                let preimage = token[colon + 1..].to_string(); // owned — needed below

                if let Some(mac) = parse_service_macaroon(macaroon_b64) {
                    if verify_preimage(&preimage, &mac.payment_hash) {
                        // Attach proof — handlers get it via Extension<L402Proof>
                        req.extensions_mut().insert(L402Proof {
                            paid: true,
                            preimage,
                            payment_hash: mac.payment_hash,
                            service: mac.service,
                        });
                        return next.run(req).await;
                    }
                }
            }

            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "Invalid L402 token" })),
            )
                .into_response();
        }
    }

    // ── No auth: issue a 402 challenge ────────────────────────────────────

    let final_price = match &config.price_fn {
        Some(f) => match f(&req).await {
            Ok(p) => p,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": e })),
                )
                    .into_response()
            }
        },
        None => config.price,
    };

    if final_price == 0 {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": "price must be > 0" })),
        )
            .into_response();
    }

    let path = req.uri().path().to_string();
    let method = req.method().to_string();
    let memo = config
        .description
        .clone()
        .unwrap_or_else(|| format!("L402 access: {} {}", method, path));

    match create_invoice(&config.node, final_price, &memo).await {
        Ok(inv) => {
            let payment_hash_hex =
                hex::encode(BASE64.decode(&inv.r_hash).unwrap_or_default());
            let service_macaroon = create_service_macaroon(&payment_hash_hex, &path);
            let www_auth = format!(
                r#"L402 macaroon="{}", invoice="{}""#,
                service_macaroon, inv.payment_request
            );

            (
                StatusCode::PAYMENT_REQUIRED,
                [(header::WWW_AUTHENTICATE, www_auth)],
                Json(serde_json::json!({
                    "code":        402,
                    "message":     "Payment Required",
                    "invoice":     inv.payment_request,
                    "macaroon":    service_macaroon,
                    "price":       final_price,
                    "description": memo,
                })),
            )
                .into_response()
        }
        Err(e) => {
            eprintln!("L402 middleware error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Payment gateway error" })),
            )
                .into_response()
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    // Known preimage/hash pair for deterministic tests
    const PREIMAGE_HEX: &str =
        "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233";

    fn payment_hash_hex() -> String {
        let bytes = hex::decode(PREIMAGE_HEX).unwrap();
        hex::encode(Sha256::digest(bytes))
    }

    fn payment_hash_b64() -> String {
        let hex = payment_hash_hex();
        BASE64.encode(hex::decode(hex).unwrap())
    }

    fn make_macaroon(payment_hash: &str, service: &str) -> String {
        BASE64.encode(
            serde_json::json!({
                "version": 1,
                "payment_hash": payment_hash,
                "service": service,
                "issued_at": 0u64,
            })
            .to_string(),
        )
    }

    fn test_config(lnd_url: String) -> L402MiddlewareConfig {
        L402MiddlewareConfig {
            node: crate::types::LndConfig {
                rest_host:      lnd_url,
                macaroon:       "deadbeef".to_string(),
                skip_tls_verify: false,
            },
            price:       10,
            description: None,
            price_fn:    None,
        }
    }

    fn app(config: L402MiddlewareConfig) -> Router {
        Router::new()
            .route("/api/test", get(|| async { "ok" }))
            .route_layer(middleware::from_fn_with_state(config, l402_middleware))
    }

    // ── 402 challenge ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn returns_402_with_invoice_and_macaroon() {
        let mock_lnd = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/invoices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "r_hash":          payment_hash_b64(),
                "payment_request": "lnbcrt100n1test",
                "add_index":       "1",
            })))
            .mount(&mock_lnd)
            .await;

        let res = app(test_config(mock_lnd.uri()))
            .oneshot(Request::get("/api/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::PAYMENT_REQUIRED);

        let body: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap(),
        )
        .unwrap();

        assert_eq!(body["code"], 402);
        assert_eq!(body["invoice"], "lnbcrt100n1test");
        assert!(body["macaroon"].as_str().unwrap().len() > 0);
        assert_eq!(body["price"], 10);
    }

    #[tokio::test]
    async fn includes_www_authenticate_header() {
        let mock_lnd = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/invoices"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "r_hash":          payment_hash_b64(),
                "payment_request": "lnbcrt100n1test",
                "add_index":       "1",
            })))
            .mount(&mock_lnd)
            .await;

        let res = app(test_config(mock_lnd.uri()))
            .oneshot(Request::get("/api/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        let www_auth = res.headers().get(header::WWW_AUTHENTICATE).unwrap();
        assert!(www_auth.to_str().unwrap().starts_with("L402 macaroon="));
    }

    // ── Preimage verification ─────────────────────────────────────────────

    #[tokio::test]
    async fn valid_token_passes_through() {
        let mac = make_macaroon(&payment_hash_hex(), "/api/test");
        let token = format!("L402 {}:{}", mac, PREIMAGE_HEX);

        let res = app(test_config("http://localhost:1".to_string()))
            .oneshot(
                Request::get("/api/test")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn wrong_preimage_returns_401() {
        let mac = make_macaroon(&payment_hash_hex(), "/api/test");
        let wrong = "deadbeef".repeat(8);
        let token = format!("L402 {}:{}", mac, wrong);

        let res = app(test_config("http://localhost:1".to_string()))
            .oneshot(
                Request::get("/api/test")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn malformed_macaroon_returns_401() {
        let token = "L402 notvalidbase64!!!:".to_string() + PREIMAGE_HEX;

        let res = app(test_config("http://localhost:1".to_string()))
            .oneshot(
                Request::get("/api/test")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn token_is_case_insensitive() {
        let mac = make_macaroon(&payment_hash_hex(), "/api/test");
        let token = format!("l402 {}:{}", mac, PREIMAGE_HEX); // lowercase

        let res = app(test_config("http://localhost:1".to_string()))
            .oneshot(
                Request::get("/api/test")
                    .header("Authorization", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
    }

    // ── LND error handling ────────────────────────────────────────────────

    #[tokio::test]
    async fn lnd_unreachable_returns_500() {
        let res = app(test_config("http://localhost:1".to_string()))
            .oneshot(Request::get("/api/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn lnd_error_response_returns_500() {
        let mock_lnd = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/invoices"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&mock_lnd)
            .await;

        let res = app(test_config(mock_lnd.uri()))
            .oneshot(Request::get("/api/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // ── Price validation ──────────────────────────────────────────────────

    #[tokio::test]
    async fn zero_price_returns_500() {
        let config = L402MiddlewareConfig {
            price: 0,
            ..test_config("http://localhost:1".to_string())
        };

        let res = app(config)
            .oneshot(Request::get("/api/test").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    // ── Cryptographic unit tests ──────────────────────────────────────────

    #[test]
    fn verify_preimage_correct() {
        assert!(verify_preimage(PREIMAGE_HEX, &payment_hash_hex()));
    }

    #[test]
    fn verify_preimage_wrong_hash() {
        assert!(!verify_preimage(PREIMAGE_HEX, "deadbeef".repeat(8).as_str()));
    }

    #[test]
    fn macaroon_round_trip() {
        let mac_b64 = create_service_macaroon(&payment_hash_hex(), "/api/test");
        let mac = parse_service_macaroon(&mac_b64).unwrap();
        assert_eq!(mac.payment_hash, payment_hash_hex());
        assert_eq!(mac.service, "/api/test");
        assert_eq!(mac.version, 1);
    }
}

// src/client.rs — L402-aware HTTP client
// Equivalent to src/client.ts
//
// Usage:
//   let client = L402Client::new(L402ClientConfig { node, max_auto_pay_sats: Some(1000) });
//   let result = client.fetch::<MyData>("https://api.example.com/data").await?;
//   println!("paid={} price={:?} sats", result.paid, result.price);

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Client;

use crate::{
    lnd::lnd_client,
    types::{L402Challenge, L402ClientConfig, L402FetchResult, LndPaymentResponse},
};

/// Drop-in HTTP client that automatically pays L402 invoices.
/// Equivalent to the object returned by `createL402Client()` in TypeScript.
pub struct L402Client {
    config: L402ClientConfig,
    http:   Client,  // for API requests to L402-protected servers
    lnd:    Client,  // for LND REST calls (may accept self-signed TLS)
    // Per-URL token cache — avoids re-paying for the same endpoint.
    // Arc<Mutex<>> makes it safe to share across async tasks.
    token_cache: Arc<Mutex<HashMap<String, String>>>,
}

impl L402Client {
    pub fn new(config: L402ClientConfig) -> Self {
        let lnd = lnd_client(config.node.skip_tls_verify);
        Self {
            config,
            http: Client::new(),
            lnd,
            token_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Fetch a URL, automatically handling any 402 Payment Required response.
    ///
    /// Flow:
    ///   1. Request with cached token if available
    ///   2. If 402 → check price against limit → pay via LND → cache token
    ///   3. Retry with Authorization header → return data
    pub async fn fetch<T>(&self, url: &str) -> Result<L402FetchResult<T>, String>
    where
        T: serde::de::DeserializeOwned,
    {
        // Use cached token if we've paid this URL before
        let cached_token = self.token_cache.lock().unwrap().get(url).cloned();

        let mut req = self.http.get(url);
        if let Some(ref token) = cached_token {
            req = req.header("Authorization", token);
        }

        let res = req.send().await.map_err(|e| e.to_string())?;

        // Not a 402 — pass through directly
        if res.status().as_u16() != 402 {
            let data = res.json::<T>().await.map_err(|e| e.to_string())?;
            return Ok(L402FetchResult {
                data,
                paid: false,
                price: None,
                preimage: None,
            });
        }

        // ── Handle 402 Payment Required ───────────────────────────────────

        let challenge: L402Challenge = res.json().await.map_err(|e| e.to_string())?;
        let max_pay = self.config.max_auto_pay_sats.unwrap_or(10_000);

        if challenge.price > max_pay {
            return Err(format!(
                "L402 price ({} sats) exceeds max_auto_pay_sats ({}). \
                 Increase the limit or pay manually.",
                challenge.price, max_pay
            ));
        }

        // Pay the Lightning invoice via LND REST
        let payment = self.pay_invoice(&challenge.invoice).await?;

        if !payment.payment_error.is_empty() {
            return Err(format!("Lightning payment failed: {}", payment.payment_error));
        }

        // Convert preimage: base64 (LND wire format) → hex (L402 standard)
        let preimage_hex = hex::encode(
            BASE64
                .decode(&payment.payment_preimage)
                .map_err(|e| e.to_string())?,
        );

        let l402_token = format!("L402 {}:{}", challenge.macaroon, preimage_hex);

        // Cache for subsequent requests to the same URL
        self.token_cache
            .lock()
            .unwrap()
            .insert(url.to_string(), l402_token.clone());

        // Retry the original request with authorization
        let data = self
            .http
            .get(url)
            .header("Authorization", &l402_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json::<T>()
            .await
            .map_err(|e| e.to_string())?;

        Ok(L402FetchResult {
            data,
            paid: true,
            price: Some(challenge.price),
            preimage: Some(preimage_hex),
        })
    }

    async fn pay_invoice(&self, payment_request: &str) -> Result<LndPaymentResponse, String> {
        self.lnd
            .post(format!(
                "{}/v1/channels/transactions",
                self.config.node.rest_host
            ))
            .header("Grpc-Metadata-macaroon", &self.config.node.macaroon)
            .json(&serde_json::json!({ "payment_request": payment_request }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json::<LndPaymentResponse>()
            .await
            .map_err(|e| e.to_string())
    }

    pub fn clear_cache(&self) {
        self.token_cache.lock().unwrap().clear();
    }

    pub fn cache_size(&self) -> usize {
        self.token_cache.lock().unwrap().len()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use wiremock::{
        matchers::{header, method, path},
        Mock, MockServer, ResponseTemplate,
    };

    const PREIMAGE_HEX: &str =
        "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233";

    fn payment_hash_hex() -> String {
        let bytes = hex::decode(PREIMAGE_HEX).unwrap();
        hex::encode(Sha256::digest(bytes))
    }

    fn preimage_b64() -> String {
        BASE64.encode(hex::decode(PREIMAGE_HEX).unwrap())
    }

    fn make_macaroon(payment_hash: &str) -> String {
        BASE64.encode(
            serde_json::json!({
                "version": 1,
                "payment_hash": payment_hash,
                "service": "/api/data",
                "issued_at": 0u64,
            })
            .to_string(),
        )
    }

    fn client(node_url: String) -> L402Client {
        L402Client::new(L402ClientConfig {
            node: crate::types::LndConfig {
                rest_host:       node_url,
                macaroon:        "deadbeef".to_string(),
                skip_tls_verify: false,
            },
            max_auto_pay_sats: Some(10_000),
        })
    }

    // ── Non-402 responses ─────────────────────────────────────────────────

    #[tokio::test]
    async fn passes_through_200_without_payment() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/data"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "data": "free content" })),
            )
            .mount(&server)
            .await;

        let result = client(server.uri())
            .fetch::<serde_json::Value>(&format!("{}/api/data", server.uri()))
            .await
            .unwrap();

        assert!(!result.paid);
        assert_eq!(result.data["data"], "free content");
    }

    // ── 402 auto-payment flow ─────────────────────────────────────────────

    #[tokio::test]
    async fn auto_pays_402_and_retries() {
        let server = MockServer::start().await;
        let mac = make_macaroon(&payment_hash_hex());

        // First call returns 402
        Mock::given(method("GET"))
            .and(path("/api/data"))
            .respond_with(ResponseTemplate::new(402).set_body_json(serde_json::json!({
                "code": 402, "message": "Payment Required",
                "invoice":     "lnbcrt100n1test",
                "macaroon":    mac,
                "price":       10,
                "description": "test",
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;

        // LND payment
        Mock::given(method("POST"))
            .and(path("/v1/channels/transactions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payment_error":    "",
                "payment_preimage": preimage_b64(),
                "payment_route":    {},
            })))
            .mount(&server)
            .await;

        // Authenticated retry returns 200
        Mock::given(method("GET"))
            .and(path("/api/data"))
            .and(header("authorization", format!("L402 {}:{}", make_macaroon(&payment_hash_hex()), PREIMAGE_HEX).as_str()))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "data": "premium content" })),
            )
            .mount(&server)
            .await;

        let result = client(server.uri())
            .fetch::<serde_json::Value>(&format!("{}/api/data", server.uri()))
            .await
            .unwrap();

        assert!(result.paid);
        assert_eq!(result.price, Some(10));
        assert_eq!(result.preimage.as_deref(), Some(PREIMAGE_HEX));
        assert_eq!(result.data["data"], "premium content");
    }

    // ── Safety limit ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn rejects_price_above_max() {
        let server = MockServer::start().await;
        let mac = make_macaroon(&payment_hash_hex());

        Mock::given(method("GET"))
            .and(path("/api/data"))
            .respond_with(ResponseTemplate::new(402).set_body_json(serde_json::json!({
                "code": 402, "message": "Payment Required",
                "invoice": "lnbcrt100n1test", "macaroon": mac,
                "price": 99_999, "description": "expensive",
            })))
            .mount(&server)
            .await;

        let c = L402Client::new(L402ClientConfig {
            node: crate::types::LndConfig {
                rest_host: server.uri(), macaroon: "x".into(), skip_tls_verify: false,
            },
            max_auto_pay_sats: Some(1_000),
        });

        let err = c
            .fetch::<serde_json::Value>(&format!("{}/api/data", server.uri()))
            .await
            .unwrap_err();

        assert!(err.contains("exceeds max_auto_pay_sats"));
    }

    // ── Token caching ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn caches_token_and_reuses_on_second_request() {
        let server = MockServer::start().await;
        let mac = make_macaroon(&payment_hash_hex());
        let url = format!("{}/api/data", server.uri());

        Mock::given(method("GET")).and(path("/api/data"))
            .respond_with(ResponseTemplate::new(402).set_body_json(serde_json::json!({
                "code": 402, "message": "Payment Required",
                "invoice": "lnbcrt100n1test", "macaroon": mac,
                "price": 10, "description": "test",
            })))
            .up_to_n_times(1)
            .mount(&server).await;

        Mock::given(method("POST")).and(path("/v1/channels/transactions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "payment_error": "", "payment_preimage": preimage_b64(), "payment_route": {},
            })))
            .up_to_n_times(1)
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/api/data"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "data": "ok" })))
            .mount(&server).await;

        let c = client(server.uri());
        let r1 = c.fetch::<serde_json::Value>(&url).await.unwrap();
        assert!(r1.paid);
        assert_eq!(c.cache_size(), 1);

        // Second request uses cached token — no 402, no payment
        let r2 = c.fetch::<serde_json::Value>(&url).await.unwrap();
        assert!(!r2.paid);
        assert_eq!(c.cache_size(), 1);
    }

    #[tokio::test]
    async fn clear_cache_resets_size() {
        let c = client("http://localhost:1".to_string());
        c.token_cache.lock().unwrap().insert("http://example.com".into(), "token".into());
        assert_eq!(c.cache_size(), 1);
        c.clear_cache();
        assert_eq!(c.cache_size(), 0);
    }
}

// src/bin/proxy_cli.rs — l402-proxy CLI binary
// Equivalent to src/proxy-cli.ts
//
// Usage:
//   l402-proxy --target http://localhost:3000 --price 10 \
//              --lnd-host https://127.0.0.1:8080 --macaroon 0201...
//
// All flags also accept env vars:
//   L402_TARGET, L402_PRICE, L402_PORT, LND_REST_HOST, LND_MACAROON, LND_SKIP_TLS

use std::{collections::HashMap, env};
use tokio::net::TcpListener;

use l402::{l402_proxy, types::LndConfig, ProxyConfig};

fn usage() -> ! {
    eprintln!(
        "
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
"
    );
    std::process::exit(1);
}

fn parse_args() -> HashMap<String, String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut map = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            let value = if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                i += 1;
                args[i].clone()
            } else {
                "true".to_string()
            };
            map.insert(key.to_string(), value);
        }
        i += 1;
    }
    map
}

fn get(args: &HashMap<String, String>, flag: &str, env_var: &str) -> Option<String> {
    args.get(flag)
        .cloned()
        .or_else(|| env::var(env_var).ok())
}

#[tokio::main]
async fn main() {
    let args = parse_args();

    let target      = get(&args, "target",      "L402_TARGET")    .unwrap_or_else(|| usage());
    let lnd_host    = get(&args, "lnd-host",    "LND_REST_HOST")  .unwrap_or_else(|| usage());
    let macaroon    = get(&args, "macaroon",    "LND_MACAROON")   .unwrap_or_else(|| usage());
    let price_str   = get(&args, "price",       "L402_PRICE")     .unwrap_or_else(|| usage());
    let port_str    = get(&args, "port",        "L402_PORT")      .unwrap_or_else(|| "8402".to_string());
    let skip_tls    = get(&args, "skip-tls",    "LND_SKIP_TLS")   .as_deref() == Some("true");
    let description = get(&args, "description", "L402_DESCRIPTION");

    let price: u64 = price_str.parse().unwrap_or_else(|_| {
        eprintln!("Error: --price must be a positive integer (got: {})", price_str);
        std::process::exit(1);
    });

    if price == 0 {
        eprintln!("Error: --price must be > 0");
        std::process::exit(1);
    }

    let port: u16 = port_str.parse().unwrap_or_else(|_| {
        eprintln!("Error: --port must be a valid port number (got: {})", port_str);
        std::process::exit(1);
    });

    let app = l402_proxy(ProxyConfig {
        target:      target.clone(),
        price,
        description: description.clone(),
        price_fn:    None,
        node: LndConfig {
            rest_host:       lnd_host,
            macaroon,
            skip_tls_verify: skip_tls,
        },
    });

    let addr = format!("0.0.0.0:{}", port);
    let listener = TcpListener::bind(&addr).await.unwrap_or_else(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            eprintln!("Error: port {} is already in use", port);
        } else {
            eprintln!("Error: failed to bind to {}: {}", addr, e);
        }
        std::process::exit(1);
    });

    println!("[l402-proxy] Listening on http://0.0.0.0:{}", port);
    println!("[l402-proxy] → {}", target);
    println!("[l402-proxy] Price: {} sats per request", price);
    if let Some(desc) = description {
        println!("[l402-proxy] Description: {}", desc);
    }

    axum::serve(listener, app).await.unwrap();
}

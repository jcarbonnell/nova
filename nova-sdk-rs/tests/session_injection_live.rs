// nova/nova-sdk-rs/tests/session_injection_live.rs
//
// Phase 0.6 — LIVE injected-path smoke (the "SDK path" step in the verify order:
// health → security invariant → happy path → SDK path). Rust mirror of the JS
// live test (nova-sdk-js/tests/session-token-injection.live.test.ts).
//
// The inline hermetic tests in lib.rs prove the SDK BEHAVES correctly offline:
// injected token used verbatim, no mint, expired → dedicated Token error. They
// structurally cannot prove the one thing only production can — that a token
// minted one way and injected another is actually ACCEPTED by MCP (verified
// against SESSION_TOKEN_SECRET / issuer / audience).
//
// This does exactly that against gmail-14.nova-sdk.near using the real
// NOVA_API_KEY from the environment. It:
//   1. mints a nova_session the normal api_key way (one direct POST — the same
//      call the SDK's api_key path makes),
//   2. injects that token into a SECOND SDK that has NO api_key,
//   3. performs a real read (get_owned_groups) through the injected path.
//
// Because sdk_b carries NO api_key, a pass can ONLY come from the injected token
// working: a broken injection returns NovaError::Auth("API key required") and
// never silently mints, so this cleanly isolates "MCP accepts an injected,
// non-self-minted session" from every other path.
//
// SMOKE, not harness: it hits production MCP over the network and gates on "the
// happy path works", not on byte-identical behaviour. It self-skips when
// NOVA_API_KEY is absent, so a keyless run never fails.
//
// DEV-DEPENDENCIES REQUIRED (integration tests are a separate crate and do NOT
// inherit the library's normal deps): reqwest (with the "json" feature) and
// serde_json must be present under [dev-dependencies] in Cargo.toml. tokio is
// already there (the existing integration tests use #[tokio::test]). See the
// note in the handover message for exact lines.

use nova_sdk_rs::{NovaSdk, NovaSdkConfig};

const LIVE_AUTH_URL: &str = "https://nova-sdk.com";
const LIVE_ACCOUNT_ID: &str = "gmail-14.nova-sdk.near";

#[tokio::test]
async fn test_injected_session_accepted_by_mcp_live() {
    // Gate: run only when a real key is present; skip cleanly otherwise.
    let api_key = match std::env::var("NOVA_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            println!("Skipping test_injected_session_accepted_by_mcp_live: NOVA_API_KEY not set");
            return;
        }
    };

    // 1. Mint a nova_session exactly as the SDK's api_key path does.
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("{}/api/auth/session-token", LIVE_AUTH_URL))
        .header("Content-Type", "application/json")
        .header("X-API-Key", &api_key)
        .json(&serde_json::json!({ "account_id": LIVE_ACCOUNT_ID }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .expect("mint request failed to send");

    assert!(
        resp.status().is_success(),
        "mint should succeed; got HTTP {}",
        resp.status()
    );

    let body: serde_json::Value = resp.json().await.expect("mint response was not JSON");
    let token = body
        .get("token")
        .and_then(|v| v.as_str())
        .expect("mint response missing `token`");
    assert!(!token.is_empty(), "minted token should be non-empty");

    // Soft sanity: the mint should be for the account we asked about.
    if let Some(acct) = body.get("account_id").and_then(|v| v.as_str()) {
        assert_eq!(acct, LIVE_ACCOUNT_ID, "mint should be for the requested account");
    }

    // 2. Inject that token into a SECOND SDK with NO api_key — the dashboard's
    //    exact path. No api_key means a pass can ONLY come from the injected
    //    token: a broken injection returns Auth("API key required"), never mints.
    let config = NovaSdkConfig::default().with_session_token(token);
    let sdk_b = NovaSdk::with_config(LIVE_ACCOUNT_ID, config).unwrap();

    // 3. Real read through the injected path. MCP verifies the nova_session; a
    //    non-error return proves MCP accepts a token the SDK did not mint.
    //    An empty vec is a valid, passing answer (account may own no groups).
    let groups = sdk_b
        .get_owned_groups()
        .await
        .expect("injected-path read should succeed against MCP");

    println!(
        "✅ injected-path read OK — {} owns {} group(s)",
        LIVE_ACCOUNT_ID,
        groups.len()
    );
}
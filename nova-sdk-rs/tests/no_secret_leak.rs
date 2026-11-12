// tests/no_secret_leak.rs — 1.4.1 harness: an SDK error never carries a credential.
//
// A tiny HTTP responder on 127.0.0.1 (tokio only, no new crate) plays both
// nova-sdk.com and MCP, and ECHOES the marker credentials back in its error
// bodies: the worst case, a server or proxy that reflects what it received.
// Each error is rendered with Display and Debug and searched for the marker.
//   S  failed session fetch, body echoes the API key        → Token error, no marker
//   M  failed MCP call, body echoes the bearer session       → Mcp error, no marker
//   D  MCP returns a value of the wrong type (a key-like string) → no value quoted
//   R  redact() shapes; X: the detector is not blind (serde quotes the value).
use nova_sdk_rs::{redact, NovaError, NovaSdk, NovaSdkConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const MARK: &str = "LEAKMARKER";
const API_KEY: &str = "nova_sk_LEAKMARKER000000000000000000000000000000000";
// header {"alg":"HS256","typ":"JWT"} . payload {"account_id":"alice.nova-sdk.near","type":"nova_session"} . marker signature
const SESSION: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Uubm92YS1zZGsubmVhciIsInR5cGUiOiJub3ZhX3Nlc3Npb24ifQ.LEAKMARKERsig";
const ACCOUNT: &str = "alice.nova-sdk.near";

/// Serves every request with `status` and `body` until the test ends. Returns the base URL.
async fn responder(status: &'static str, body: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 16384];
                let _ = sock.read(&mut buf).await; // request content is irrelevant here
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

fn assert_no_marker(err: &NovaError) {
    let shown = format!("{err}");
    let debug = format!("{err:?}");
    assert!(!shown.contains(MARK), "Display leaks: {shown}");
    assert!(!debug.contains(MARK), "Debug leaks: {debug}");
}

fn sdk(base: &str, api_key: Option<&str>, session: Option<&str>) -> NovaSdk {
    let mut config = NovaSdkConfig::default();
    if let Some(k) = api_key { config = config.with_api_key(k); }
    if let Some(s) = session { config = config.with_session_token(s); }
    config.auth_url = base.to_string();
    config.mcp_url = base.to_string();
    NovaSdk::with_config(ACCOUNT, config).unwrap()
}

#[tokio::test]
async fn s_failed_session_fetch_echoing_the_key() {
    let base = responder("401 Unauthorized", format!(r#"{{"error":"Invalid API key {API_KEY}"}}"#)).await;
    let err = sdk(&base, Some(API_KEY), None).get_owned_groups().await.unwrap_err();
    assert!(matches!(err, NovaError::Token(_)), "expected Token, got {err:?}");
    assert!(err.to_string().contains("401") && err.to_string().contains("Invalid API key [redacted]"), "got: {err}");
    assert_no_marker(&err);
}

#[tokio::test]
async fn m_failed_mcp_call_echoing_the_session() {
    let base = responder("401 Unauthorized", format!(r#"{{"error":"Auth failed: Bearer {SESSION}"}}"#)).await;
    let err = sdk(&base, None, Some(SESSION)).get_owned_groups().await.unwrap_err();
    assert!(matches!(err, NovaError::Mcp(_)), "expected Mcp, got {err:?}");
    assert!(err.to_string().contains("get_owned_groups") && err.to_string().contains("Auth failed: [redacted]"), "got: {err}");
    assert_no_marker(&err);
}

#[tokio::test]
async fn d_wrong_type_response_quotes_no_value() {
    // A key-like value where a list is expected: serde would quote it verbatim.
    let base = responder("200 OK", format!(r#"{{"result":"{MARK}c2VjcmV0LWZpbGUta2V5LWJ5dGVz"}}"#)).await;
    let err = sdk(&base, None, Some(SESSION)).get_owned_groups().await.unwrap_err();
    assert!(matches!(err, NovaError::Mcp(_)), "expected Mcp, got {err:?}");
    assert!(err.to_string().contains("Failed to deserialize MCP response for 'get_owned_groups'"), "got: {err}");
    assert_no_marker(&err);
}

#[test]
fn r_redact_shapes() {
    assert_eq!(redact(&format!("Authorization: Bearer {SESSION}")), "Authorization: [redacted]");
    assert_eq!(redact(&format!("key {API_KEY} end")), "key [redacted] end");
    assert_eq!(redact(&format!("tok {SESSION} end")), "tok [redacted] end");
    assert_eq!(redact("u?a=1&api_key=s3cret&b=2"), "u?a=1&api_key=[redacted]&b=2");
    for benign in ["Invalid API key", "MCP tool 'x' failed (401 Unauthorized): no", "héllo ✓ bearer"] {
        assert_eq!(redact(benign), benign);
    }
}

#[test]
fn x_detector_is_not_blind() {
    // What 1.4.0 put in the error for case D: serde's message quotes the value.
    let e = serde_json::from_value::<Vec<String>>(serde_json::json!(format!("{MARK}c2VjcmV0"))).unwrap_err();
    assert!(e.to_string().contains(MARK));
    // And what an unredacted 1.4.0 Token/Mcp message would carry.
    assert!(format!("Failed to get session token (401): Invalid API key {API_KEY}").contains(MARK));
}

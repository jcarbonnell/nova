//! nova-reborn — NOVA's IronClaw Reborn (`near:agent@0.4.1`) tool extension.
//!
//! Successor to `nova-submit` (`near:agent@0.3.0`, unloadable on Reborn 1.4.1 —
//! F56). Calls the EXISTING NOVA MCP API; nothing in the NOVA backend,
//! contract, or SDK changes. The agent's API key is HOST-INJECTED as the
//! `X-API-Key` header on the session-token request (F58 / D7): it is never a
//! tool parameter, never read by this guest, and never appears in any output.
//!
//! SLICE 2: real `store_file` per nova-tool-interface §5.
//!   1. hash gate (D10)    — before ANY network call, log, or encryption
//!   2. size gate          — before any network call
//!   3. session token      — key host-injected; token must look like a JWT
//!   4. membership check   — auth_status (free view); no implicit join (§5.3)
//!   5. prepare_upload     — per-file key + upload_id
//!   6. AES-256-GCM        — fresh random nonce per upload (F59, §5.2)
//!   7. finalize_upload    — structured output incl. network (D11)
//!
//! Secrets discipline: the session JWT lives only in local variables. It is
//! never logged, never placed in a failure message, never returned (§5.4).

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

wit_bindgen::generate!({
    world: "sandboxed-tool",
    path: "wit/tool.wit",
});

use crate::exports::near::agent::tool::{ErrorKind, GuestFailure, Request, Response};
use crate::near::agent::host::{self, HttpErrorKind, HttpFailure, LogLevel};

// ---------------------------------------------------------------------------
// Endpoints and limits
// ---------------------------------------------------------------------------

/// Session-token exchange. The manifest's credential audience is this host, so
/// the host injects X-API-Key here and nowhere else.
const NOVA_AUTH_URL: &str = "https://nova-sdk.com/api/auth/session-token";
/// NOVA MCP (Phala dstack). Reached with the tool-carried session Bearer.
const NOVA_MCP_BASE: &str =
    "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network";

/// Maximum `content` size in bytes (documented in the release). Graphs are
/// ~5 KB today; content transits the model's output (F37), so large payloads
/// are impractical regardless. Well under FastFS's ~4 MB cap after base64.
const MAX_CONTENT_BYTES: usize = 1024 * 1024;

const TIMEOUT_MS: u32 = 30_000;
const FINALIZE_TIMEOUT_MS: u32 = 60_000;

// ---------------------------------------------------------------------------
// Failure vocabulary (§5). Every failure path goes through this enum.
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum NovaFailure {
    /// `content` does not hash to `sha256`. No request sent. (§5, §7.5)
    HashMismatch,
    /// Session token refused (bad/absent key, or account_id ≠ key's account).
    AuthFailed(String),
    /// The account is not a member of `group_id`.
    NotMember(String),
    /// Any later step failed.
    UploadFailed(String),
    /// Content exceeds MAX_CONTENT_BYTES. No request sent. (deviation: extra code)
    ContentTooLarge(usize),
    /// Parameters did not parse. (deviation: extra code)
    BadInput(String),
}

impl NovaFailure {
    fn into_guest_failure(self) -> GuestFailure {
        let (kind, code, message) = match self {
            NovaFailure::HashMismatch => (
                ErrorKind::Input,
                "hash_mismatch",
                "content does not hash to the provided sha256; nothing was sent".to_string(),
            ),
            NovaFailure::AuthFailed(m) => (ErrorKind::AuthRequired, "auth_failed", m),
            NovaFailure::NotMember(m) => (ErrorKind::Client, "not_member", m),
            NovaFailure::UploadFailed(m) => (ErrorKind::OperationFailed, "upload_failed", m),
            NovaFailure::ContentTooLarge(n) => (
                ErrorKind::Input,
                "content_too_large",
                format!("content is {n} bytes; the maximum is {MAX_CONTENT_BYTES}"),
            ),
            NovaFailure::BadInput(m) => (ErrorKind::Input, "bad_input", m),
        };
        GuestFailure {
            kind,
            code: Some(code.to_string()),
            message: Some(message),
        }
    }
}

// ---------------------------------------------------------------------------
// Parameters and output (§5)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct StoreFileParams {
    /// The agent's NOVA account ID. Must match the host-injected API key.
    account_id: String,
    /// Target group the account already belongs to. store_file does NOT join.
    group_id: String,
    /// Stored filename.
    filename: String,
    /// The full file content (UTF-8 text).
    content: String,
    /// 64 hex chars: SHA-256 of the UTF-8 bytes of `content`.
    sha256: String,
}

#[derive(Debug, Serialize)]
struct StoreFileResult {
    cid: String,
    trans_id: String,
    file_hash: String,
    sha256: String,
    group_id: String,
    account_id: String,
    filename: String,
    size_bytes: usize,
    network: String,
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

struct NovaReborn;

impl exports::near::agent::tool::Guest for NovaReborn {
    fn execute(req: Request) -> Response {
        match store_file(&req.params) {
            Ok(output) => Response::Success(output),
            Err(f) => Response::Failure(f.into_guest_failure()),
        }
    }

    fn schema() -> String {
        let schema = schemars::schema_for!(StoreFileParams);
        serde_json::to_string(&schema).expect("schema serialization is infallible")
    }

    fn description() -> String {
        "Encrypt a UTF-8 text file with AES-256-GCM and upload it to a NOVA group \
         on NEAR under the agent's own NOVA account. Verifies the content against \
         the provided sha256 before doing anything. The NOVA API key is \
         host-injected (never a parameter). The account must already be a member \
         of the group. Returns the storage cid, the NEAR trans_id, the on-chain \
         file_hash, and the network."
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// store_file
// ---------------------------------------------------------------------------

fn store_file(params: &str) -> Result<String, NovaFailure> {
    let p: StoreFileParams = serde_json::from_str(params)
        .map_err(|e| NovaFailure::BadInput(format!("invalid store_file parameters: {e}")))?;

    // 1. Hash gate (D10). MUST stay first: no host call (log or http) may
    //    happen before it. The unit test `hash_mismatch_sends_nothing` relies
    //    on this — any host call on the native test target panics.
    let content_bytes = p.content.as_bytes();
    let computed = sha256_hex(content_bytes);
    if !hash_matches(&computed, &p.sha256) {
        return Err(NovaFailure::HashMismatch);
    }

    // 2. Size gate — also before any network call.
    if content_bytes.len() > MAX_CONTENT_BYTES {
        return Err(NovaFailure::ContentTooLarge(content_bytes.len()));
    }

    let network = network_for(&p.account_id);
    host::log(
        LogLevel::Info,
        &format!(
            "nova.store_file: '{}' ({} bytes) -> group '{}' as {} [{}]",
            p.filename,
            content_bytes.len(),
            p.group_id,
            p.account_id,
            network
        ),
    );

    // 3. Session token (API key host-injected).
    let token = get_session_token(&p.account_id)?;

    // 4. Membership — fail cleanly before spending anything (no implicit join).
    ensure_member(&token, &p.account_id, &p.group_id)?;

    // 5. prepare_upload.
    let (upload_id, key_b64) = prepare_upload(&token, &p.account_id, &p.group_id, &p.filename)?;

    // 6. Encrypt with a fresh random nonce.
    let nonce = fresh_nonce()?;
    let encrypted_b64 = encrypt_v0(&key_b64, content_bytes, &nonce)?;

    // 7. finalize_upload. file_hash = verified plaintext SHA-256 (the on-chain anchor).
    let (cid, trans_id, recorded_hash) =
        finalize_upload(&token, &p.account_id, &upload_id, &encrypted_b64, &computed)?;

    host::log(LogLevel::Info, &format!("nova.store_file: success, cid={cid}"));

    let result = StoreFileResult {
        cid,
        trans_id,
        file_hash: recorded_hash.unwrap_or_else(|| computed.clone()),
        sha256: computed,
        group_id: p.group_id,
        account_id: p.account_id,
        filename: p.filename,
        size_bytes: content_bytes.len(),
        network: network.to_string(),
    };
    serde_json::to_string(&result)
        .map_err(|e| NovaFailure::UploadFailed(format!("failed to serialize result: {e}")))
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no host calls)
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `provided` must be 64 hex chars equal to the computed digest (case-insensitive).
/// A malformed hash cannot match, so it is also a mismatch.
fn hash_matches(computed: &str, provided: &str) -> bool {
    provided.len() == 64
        && provided.chars().all(|c| c.is_ascii_hexdigit())
        && provided.eq_ignore_ascii_case(computed)
}

/// Same rule MCP uses to pick its network config (`'.testnet' in account_id`).
fn network_for(account_id: &str) -> &'static str {
    if account_id.to_ascii_lowercase().contains(".testnet") {
        "testnet"
    } else {
        "mainnet"
    }
}

/// Structural JWT check: three non-empty base64url segments, header starting
/// `eyJ`. If the host's secret scanner redacted the token on its way into the
/// guest (nova-tool-interface §6.1), this catches it with a clear message.
fn looks_like_jwt(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3
        && token.starts_with("eyJ")
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '=')
        })
}

fn fresh_nonce() -> Result<[u8; 12], NovaFailure> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce)
        .map_err(|e| NovaFailure::UploadFailed(format!("secure RNG unavailable: {e}")))?;
    Ok(nonce)
}

/// v0 wire format, byte-compatible with the NOVA SDK's frozen decryptV0:
/// base64( nonce(12) || ciphertext || tag(16) ).
fn encrypt_v0(key_b64: &str, plaintext: &[u8], nonce: &[u8; 12]) -> Result<String, NovaFailure> {
    let key = B64
        .decode(key_b64)
        .map_err(|e| NovaFailure::UploadFailed(format!("prepare_upload returned a non-base64 key: {e}")))?;
    if key.len() != 32 {
        return Err(NovaFailure::UploadFailed(format!(
            "expected a 32-byte AES-256 key, got {} bytes",
            key.len()
        )));
    }
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| NovaFailure::UploadFailed(format!("cipher init failed: {e}")))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad: b"" })
        .map_err(|e| NovaFailure::UploadFailed(format!("encryption failed: {e}")))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

fn http_kind_name(kind: &HttpErrorKind) -> &'static str {
    match kind {
        HttpErrorKind::AuthRequired => "auth-required",
        HttpErrorKind::Input => "input",
        HttpErrorKind::OutputTooLarge => "output-too-large",
        HttpErrorKind::Executor => "executor",
        HttpErrorKind::NetworkDenied => "network-denied",
        HttpErrorKind::Client => "client",
        HttpErrorKind::OperationFailed => "operation-failed",
    }
}

/// Map a typed host transport failure into our vocabulary.
fn map_http_failure(step: &str, f: HttpFailure) -> NovaFailure {
    let detail = f.message.unwrap_or_default();
    match f.kind {
        HttpErrorKind::AuthRequired => NovaFailure::AuthFailed(format!(
            "{step}: host reports auth required — is the NOVA API key configured in setup? {detail}"
        )),
        _ => NovaFailure::UploadFailed(format!(
            "{step}: host transport failure ({}) {detail}",
            http_kind_name(&f.kind)
        )),
    }
}

fn snippet(body: &[u8]) -> String {
    let s = String::from_utf8_lossy(body);
    s.chars().take(200).collect()
}

/// Step 3: exchange the host-injected API key for a session JWT.
fn get_session_token(account_id: &str) -> Result<String, NovaFailure> {
    let body = serde_json::json!({ "account_id": account_id }).to_string().into_bytes();
    // No X-API-Key here: the host injects it for this audience (manifest).
    let headers = serde_json::json!({ "Content-Type": "application/json" }).to_string();

    let resp = host::http_request("POST", NOVA_AUTH_URL, &headers, Some(body.as_slice()), Some(TIMEOUT_MS))
        .map_err(|f| map_http_failure("session-token", f))?;

    match resp.status {
        200 => {}
        401 | 403 | 404 => {
            return Err(NovaFailure::AuthFailed(format!(
                "session-token refused (HTTP {}): check the NOVA API key and that account_id matches it",
                resp.status
            )))
        }
        s => {
            return Err(NovaFailure::UploadFailed(format!(
                "session-token returned HTTP {s}: {}",
                snippet(&resp.body)
            )))
        }
    }

    let json: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| NovaFailure::UploadFailed(format!("session-token response was not JSON: {e}")))?;
    let token = json
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| NovaFailure::UploadFailed("session-token response had no `token` field".into()))?
        .to_string();

    if !looks_like_jwt(&token) {
        // Never echo the value. If it was redacted, echoing is pointless; if not, it's a secret.
        return Err(NovaFailure::UploadFailed(
            "session token received from nova-sdk.com is not a well-formed JWT — it may have \
             been redacted by the host's secret scanner (nova-tool-interface §6.1)"
                .into(),
        ));
    }
    Ok(token)
}

/// POST to an MCP /tools/* endpoint; returns the unwrapped `result` payload.
fn mcp_post(token: &str, account_id: &str, tool: &str, body: Value, timeout_ms: u32) -> Result<Value, NovaFailure> {
    let headers = serde_json::json!({
        "Content-Type": "application/json",
        "Authorization": format!("Bearer {token}"),
        "x-account-id": account_id,
    })
    .to_string();
    let body = body.to_string().into_bytes();
    let url = format!("{NOVA_MCP_BASE}/tools/{tool}");

    let resp = host::http_request("POST", &url, &headers, Some(body.as_slice()), Some(timeout_ms))
        .map_err(|f| map_http_failure(tool, f))?;

    if resp.status == 401 {
        return Err(NovaFailure::AuthFailed(format!(
            "MCP rejected the session token on {tool} (HTTP 401)"
        )));
    }
    if resp.status != 200 {
        let text = snippet(&resp.body);
        // Contract-level membership panic surfaces as a 500 with this text.
        if text.to_ascii_lowercase().contains("not authorized") {
            return Err(NovaFailure::NotMember(format!("{tool}: {text}")));
        }
        return Err(NovaFailure::UploadFailed(format!("{tool} returned HTTP {}: {text}", resp.status)));
    }

    let json: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| NovaFailure::UploadFailed(format!("{tool} response was not JSON: {e}")))?;
    Ok(json.get("result").cloned().unwrap_or(json))
}

/// Step 4: membership via auth_status (free contract view on the MCP side).
fn ensure_member(token: &str, account_id: &str, group_id: &str) -> Result<(), NovaFailure> {
    let result = mcp_post(token, account_id, "auth_status", serde_json::json!({ "group_id": group_id }), TIMEOUT_MS)?;
    match result.get("authorized_for_group").and_then(|v| v.as_bool()) {
        Some(true) => Ok(()),
        _ => Err(NovaFailure::NotMember(format!(
            "{account_id} is not a member of group '{group_id}' (store_file does not join groups)"
        ))),
    }
}

/// Step 5: prepare_upload → (upload_id, per-file key).
fn prepare_upload(token: &str, account_id: &str, group_id: &str, filename: &str) -> Result<(String, String), NovaFailure> {
    let r = mcp_post(
        token,
        account_id,
        "prepare_upload",
        serde_json::json!({ "group_id": group_id, "filename": filename }),
        TIMEOUT_MS,
    )?;
    let upload_id = r.get("upload_id").and_then(|v| v.as_str())
        .ok_or_else(|| NovaFailure::UploadFailed("prepare_upload response had no `upload_id`".into()))?;
    let key = r.get("key").and_then(|v| v.as_str())
        .ok_or_else(|| NovaFailure::UploadFailed("prepare_upload response had no `key`".into()))?;
    Ok((upload_id.to_string(), key.to_string()))
}

/// Step 7: finalize_upload → (cid, trans_id, recorded file_hash).
/// No `format` field: v0 wire format, decoded via the frozen v0 path everywhere.
fn finalize_upload(
    token: &str,
    account_id: &str,
    upload_id: &str,
    encrypted_b64: &str,
    file_hash: &str,
) -> Result<(String, String, Option<String>), NovaFailure> {
    let r = mcp_post(
        token,
        account_id,
        "finalize_upload",
        serde_json::json!({
            "upload_id": upload_id,
            "encrypted_data": encrypted_b64,
            "file_hash": file_hash,
        }),
        FINALIZE_TIMEOUT_MS,
    )?;
    let cid = r.get("location").or_else(|| r.get("cid")).and_then(|v| v.as_str())
        .ok_or_else(|| NovaFailure::UploadFailed("finalize_upload response had no location/cid".into()))?
        .to_string();
    let trans_id = r.get("trans_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let recorded = r.get("file_hash").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok((cid, trans_id, recorded))
}

export!(NovaReborn);

// ---------------------------------------------------------------------------
// Tests (native target; host calls are unreachable here, which is exactly
// what proves the gates fire before any network call)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn params(content: &str, sha: &str) -> String {
        serde_json::json!({
            "account_id": "agent1.nova-sdk-7.testnet",
            "group_id": "agentic-economy-oracle",
            "filename": "graph.json",
            "content": content,
            "sha256": sha,
        })
        .to_string()
    }

    #[test]
    fn hash_mismatch_sends_nothing() {
        // Wrong hash must return HashMismatch WITHOUT touching the host. On the
        // native target any host call panics, so returning at all proves the
        // gate fires before any log or http request (§7.5 negative control).
        let wrong = "0".repeat(64);
        assert_eq!(store_file(&params("{\"a\":1}", &wrong)), Err(NovaFailure::HashMismatch));
    }

    #[test]
    fn malformed_hash_is_a_mismatch() {
        assert_eq!(store_file(&params("x", "nothex")), Err(NovaFailure::HashMismatch));
    }

    #[test]
    fn oversized_content_rejected_before_network() {
        let big = "a".repeat(MAX_CONTENT_BYTES + 1);
        let sha = sha256_hex(big.as_bytes());
        assert_eq!(
            store_file(&params(&big, &sha)),
            Err(NovaFailure::ContentTooLarge(MAX_CONTENT_BYTES + 1))
        );
    }

    #[test]
    fn hash_check_is_case_insensitive_and_exact() {
        let h = sha256_hex(b"hello");
        assert!(hash_matches(&h, &h));
        assert!(hash_matches(&h, &h.to_ascii_uppercase()));
        assert!(!hash_matches(&h, &sha256_hex(b"hellO")));
    }

    #[test]
    fn network_follows_mcp_rule() {
        assert_eq!(network_for("agent1.nova-sdk-7.testnet"), "testnet");
        assert_eq!(network_for("alice.nova-sdk.near"), "mainnet");
    }

    #[test]
    fn jwt_shape_check() {
        assert!(looks_like_jwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln"));
        assert!(!looks_like_jwt("[REDACTED]"));
        assert!(!looks_like_jwt("eyJ.only-two"));
    }

    #[test]
    fn encrypt_roundtrip_and_layout() {
        let key = [7u8; 32];
        let key_b64 = B64.encode(key);
        let nonce = fresh_nonce().unwrap();
        let pt = b"{\"graph\":[1,2,3]}";
        let blob = B64.decode(encrypt_v0(&key_b64, pt, &nonce).unwrap()).unwrap();
        assert_eq!(blob.len(), 12 + pt.len() + 16, "nonce || ct || tag");
        assert_eq!(&blob[..12], &nonce);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let out = cipher
            .decrypt(Nonce::from_slice(&blob[..12]), Payload { msg: &blob[12..], aad: b"" })
            .unwrap();
        assert_eq!(out, pt);
    }

    #[test]
    fn same_content_twice_gives_different_ciphertexts() {
        // §7.6 randomness control, at unit level.
        let key_b64 = B64.encode([9u8; 32]);
        let a = encrypt_v0(&key_b64, b"same", &fresh_nonce().unwrap()).unwrap();
        let b = encrypt_v0(&key_b64, b"same", &fresh_nonce().unwrap()).unwrap();
        assert_ne!(a, b);
    }
}
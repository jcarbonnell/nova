//! nova-reborn — NOVA's IronClaw Reborn (`near:agent@0.4.1`) tool extension.
//!
//! Successor to `nova-submit` (`near:agent@0.3.0`, now unloadable on Reborn
//! 1.4.1 — F56). Exposes NOVA's capabilities as sandboxed tools that call the
//! EXISTING NOVA MCP API; nothing in the NOVA backend, contract, or SDK
//! changes. The agent's API key is HOST-INJECTED as the `X-API-Key` header
//! (F58 / D7) and is never a tool parameter and never appears in any output.
//!
//! Extension id: `nova` (the dashboard sets per-tool states by id — F43/F45).
//! Tool ids: `nova.<method>`, stable across releases.
//!
//! SLICE 1 (this file): skeleton only. The 0.4.1 contract is wired end to end
//! — `execute` returns the `response` variant (`success` / `failure`), failures
//! use the closed `error-kind` vocabulary — but `store_file`'s body is a stub.
//! The goal of slice 1 is that this builds to a WASM component and imports
//! cleanly into Reborn (the thing the 0.3.0 tool cannot do). No network, no
//! crypto yet; those are slice 2.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

wit_bindgen::generate!({
    world: "sandboxed-tool",
    path: "wit/tool.wit",
});

use crate::exports::near::agent::tool::{
    ErrorKind, GuestFailure, Request, Response,
};

// ---------------------------------------------------------------------------
// Failure vocabulary
//
// The Cleanroom spec (§5) fixes four store_file failure codes, each mapped to a
// closed `error-kind` from the 0.4.1 WIT. We model them as a small Rust enum so
// every failure path in the tool is forced through this exact, typed set — the
// dashboard's negative control (§7.5) depends on `hash_mismatch` being exact.
//
// code  = the stable string identifier the dashboard switches on.
// kind  = the WIT error-kind the host maps to a dispatch error.
// NOTE: neither `code` nor `message` must EVER carry the session JWT or the API
// key. The host scrubs them at the sandbox-exit chokepoint, but we never put
// secrets there in the first place (defence by construction, not by the host).
// ---------------------------------------------------------------------------

enum NovaFailure {
    /// `content` does not hash to `sha256`. No network request sent. (§5, §7.5)
    HashMismatch,
    /// Session token refused — bad/absent key, or account_id ≠ key's account.
    AuthFailed(String),
    /// The account is not a member of `group_id`.
    NotMember(String),
    /// Any later step fails; `message` carries host-scrubbed detail.
    UploadFailed(String),
    /// Parameters did not parse / were structurally invalid.
    BadInput(String),
}

impl NovaFailure {
    fn into_guest_failure(self) -> GuestFailure {
        let (kind, code, message) = match self {
            NovaFailure::HashMismatch => (
                ErrorKind::Input,
                "hash_mismatch",
                Some("content does not hash to the provided sha256".to_string()),
            ),
            NovaFailure::AuthFailed(m) => (ErrorKind::AuthRequired, "auth_failed", Some(m)),
            NovaFailure::NotMember(m) => (ErrorKind::Client, "not_member", Some(m)),
            NovaFailure::UploadFailed(m) => (ErrorKind::OperationFailed, "upload_failed", Some(m)),
            NovaFailure::BadInput(m) => (ErrorKind::Input, "bad_input", Some(m)),
        };
        GuestFailure {
            kind,
            code: Some(code.to_string()),
            message,
        }
    }
}

// ---------------------------------------------------------------------------
// store_file parameters
//
// NO api_key here (F58 / D7): the key is host-injected as X-API-Key, never a
// parameter. account_id must match the injected key or authentication fails.
// sha256 is the dashboard-computed hash of the UTF-8 bytes of `content`; the
// tool verifies `content` against it BEFORE any network call (D10, §5.2.1).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct StoreFileParams {
    /// The agent's NOVA account ID, e.g. `agent1.nova-sdk-7.testnet`.
    /// Must match the injected API key; a mismatch fails authentication.
    account_id: String,
    /// Target group the account already belongs to. store_file does NOT join.
    group_id: String,
    /// Stored filename, e.g. `graph.json`.
    filename: String,
    /// The full file content to encrypt and upload (UTF-8 text).
    content: String,
    /// 64 lowercase hex chars: SHA-256 of the UTF-8 bytes of `content`,
    /// computed by the dashboard from the source file. Verified before upload.
    sha256: String,
}

// Success output shape (§5). `network` makes testnet/mainnet identifiable (D11).
// Populated for real in slice 2; the stub never returns this.
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
        "Encrypt a UTF-8 text file with AES-256-GCM and upload it to a NOVA \
         group on NEAR, under the agent's own NOVA account. Verifies the \
         content against the provided sha256 before doing anything. The NOVA \
         API key is host-injected (never a parameter). Parameters: account_id \
         (the agent's NOVA account), group_id (a group the account already \
         belongs to), filename, content (UTF-8 text), and sha256 (64 hex \
         chars, SHA-256 of the content bytes). Returns the storage cid, the \
         NEAR trans_id, and the on-chain file_hash."
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// store_file — SLICE 1 STUB.
//
// Parses params (proving the schema + param plumbing work under 0.4.1) and
// returns a clear not-implemented failure. Slice 2 replaces the body with the
// real sequence: hash-gate → session-token → prepare_upload → random-nonce
// AES-GCM → finalize_upload → structured output.
// ---------------------------------------------------------------------------

fn store_file(params: &str) -> Result<String, NovaFailure> {
    let _p: StoreFileParams = serde_json::from_str(params)
        .map_err(|e| NovaFailure::BadInput(format!("invalid store_file parameters: {e}")))?;

    Err(NovaFailure::UploadFailed(
        "nova-reborn slice 1: store_file is not implemented yet (skeleton build)".to_string(),
    ))
}

export!(NovaReborn);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_parse_without_api_key() {
        // api_key must NOT be a field — it's host-injected. A params object with
        // the five expected fields parses; presence of api_key is ignored by
        // serde (no such field), which is the point.
        let json = r#"{
            "account_id": "agent1.nova-sdk-7.testnet",
            "group_id": "agentic-economy-oracle",
            "filename": "graph.json",
            "content": "{}",
            "sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        }"#;
        let p: StoreFileParams = serde_json::from_str(json).expect("should parse");
        assert_eq!(p.account_id, "agent1.nova-sdk-7.testnet");
        assert_eq!(p.sha256.len(), 64);
    }

    #[test]
    fn failure_codes_map_to_closed_kinds() {
        // The four Cleanroom §5 codes map to the exact closed error-kinds.
        let cases = [
            (NovaFailure::HashMismatch, "hash_mismatch"),
            (NovaFailure::AuthFailed("x".into()), "auth_failed"),
            (NovaFailure::NotMember("x".into()), "not_member"),
            (NovaFailure::UploadFailed("x".into()), "upload_failed"),
        ];
        for (f, expected_code) in cases {
            let gf = f.into_guest_failure();
            assert_eq!(gf.code.as_deref(), Some(expected_code));
        }
    }
}

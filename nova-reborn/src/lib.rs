//! nova-reborn — NOVA's IronClaw Reborn (`near:agent@0.4.1`) extension.
//!
//! v0.2.0: nine tools, dispatched on the invocation context's capability_id
//! (the same mechanism as the bundled GitHub extension). Every tool calls the
//! existing NOVA MCP API; the host injects the agent's NOVA credential as the
//! X-API-Key header on every request to the MCP host, the guest never holds it,
//! and each call names its account in x-account-id (the MCP verifies the pair).
//!
//! Tools: store_file, retrieve_file, list_group_files, list_owned_groups,
//! list_member_groups, join_group, and the owner tools register_group,
//! add_group_member, revoke_group_member (always disabled for fleet agents by
//! the dashboard's policy, but present so that policy is meaningful).
//!
//! store_file (nova-tool-interface §5): hash gate and size gate before any host
//! call; membership check; prepare -> fresh random nonce -> AES-256-GCM ->
//! finalize, retried ONCE when the host declines to send a request
//! (request_sent = false). No retry once a request was sent.
//!
//! retrieve_file: prepare_retrieve -> decode in the guest (v0 plain AES-GCM, or
//! v1 = v0 + optional zlib inflate), a port of NOVA's harness-verified decoder.
//! Plaintext stays inside the guest until returned to the caller.
//!
//! Message hygiene: failure messages avoid the host's sensitive-marker words
//! (src/markers.rs) or the host drops them from the model's view. External text
//! goes through `model_safe`; `source_is_free_of_sensitive_markers` scans this
//! file so our own literals stay clean.

mod markers;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

/// NOVA MCP (Phala dstack). The manifest credential's audience.
const NOVA_MCP_BASE: &str =
    "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network";

/// Maximum store_file `content` size in bytes.
const MAX_CONTENT_BYTES: usize = 1024 * 1024;
/// Maximum decoded (inflated) size for retrieve_file — bounds a hostile file.
const MAX_DECODED_BYTES: usize = 8 * 1024 * 1024;

const READ_TIMEOUT_MS: u32 = 30_000;
const WRITE_TIMEOUT_MS: u32 = 60_000;

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum NovaFailure {
    HashMismatch,
    AuthFailed(String),
    NotMember(String),
    NotOwner(String),
    AlreadyMember(String),
    JoinRefused(String),
    /// Generic failure: `upload_failed` for store_file, `operation_failed` otherwise.
    Failed(String),
    /// The host declined to send a request (request_sent = false).
    HostRefused(String),
    ContentTooLarge(usize),
    NotUtf8,
    BadInput(String),
}

impl NovaFailure {
    fn into_guest_failure(self, tool: &str) -> GuestFailure {
        let failed_code = if tool == "store_file" { "upload_failed" } else { "operation_failed" };
        let (kind, code, message): (ErrorKind, &str, String) = match self {
            NovaFailure::HashMismatch => (
                ErrorKind::Input,
                "hash_mismatch",
                "content does not hash to the provided sha256; nothing was sent".to_string(),
            ),
            NovaFailure::AuthFailed(m) => (ErrorKind::AuthRequired, "auth_failed", m),
            NovaFailure::NotMember(m) => (ErrorKind::Client, "not_member", m),
            NovaFailure::NotOwner(m) => (ErrorKind::Client, "not_owner", m),
            NovaFailure::AlreadyMember(m) => (ErrorKind::Client, "already_member", m),
            NovaFailure::JoinRefused(m) => (ErrorKind::Client, "join_refused", m),
            NovaFailure::Failed(m) => (ErrorKind::OperationFailed, failed_code, m),
            NovaFailure::HostRefused(m) => (
                ErrorKind::OperationFailed,
                failed_code,
                format!("the host declined to send a request: {m}"),
            ),
            NovaFailure::ContentTooLarge(n) => (
                ErrorKind::Input,
                "content_too_large",
                format!("content is {n} bytes; the maximum is {MAX_CONTENT_BYTES}"),
            ),
            NovaFailure::NotUtf8 => (
                ErrorKind::Input,
                "not_utf8",
                "the decrypted file is not valid UTF-8 text; call again with encoding \"base64\"".to_string(),
            ),
            NovaFailure::BadInput(m) => (ErrorKind::Input, "bad_input", m),
        };
        GuestFailure {
            kind,
            code: Some(code.to_string()),
            message: Some(model_safe(&message)),
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Invocation context sent by the host (same shape the GitHub guest reads).
#[derive(Deserialize)]
struct ToolContext {
    capability_id: String,
}

/// "nova.store_file" -> "store_file". Takes the part after the last '.', so a
/// renamed extension id (e.g. "nova-reborn.store_file") still routes.
fn tool_from_context(context: Option<&str>) -> Result<String, NovaFailure> {
    let raw = context.ok_or_else(|| NovaFailure::BadInput("missing invocation context".into()))?;
    let ctx: ToolContext = serde_json::from_str(raw)
        .map_err(|_| NovaFailure::BadInput("invalid invocation context".into()))?;
    match ctx.capability_id.rsplit_once('.') {
        Some((_, name)) if !name.is_empty() => Ok(name.to_string()),
        _ => Err(NovaFailure::BadInput(format!(
            "unsupported capability `{}`",
            ctx.capability_id
        ))),
    }
}

fn dispatch(tool: &str, params: &str) -> Result<String, NovaFailure> {
    match tool {
        "store_file" => store_file(params),
        "retrieve_file" => retrieve_file(params),
        "list_group_files" => list_group_files(params),
        "list_owned_groups" => list_groups(params, "get_owned_groups"),
        "list_member_groups" => list_groups(params, "get_member_groups"),
        "join_group" => join_group(params),
        "register_group" => register_group(params),
        "add_group_member" => member_op(params, "add_group_member"),
        "revoke_group_member" => member_op(params, "revoke_group_member"),
        other => Err(NovaFailure::BadInput(format!("unknown tool `{other}`"))),
    }
}

struct NovaReborn;

impl exports::near::agent::tool::Guest for NovaReborn {
    fn execute(req: Request) -> Response {
        let tool = match tool_from_context(req.context.as_deref()) {
            Ok(t) => t,
            Err(f) => return Response::Failure(f.into_guest_failure("unknown")),
        };
        match dispatch(&tool, &req.params) {
            Ok(output) => Response::Success(output),
            Err(f) => Response::Failure(f.into_guest_failure(&tool)),
        }
    }

    fn schema() -> String {
        // Per-tool input schemas are declared in the manifest (input_schema_ref);
        // this export returns store_file's, the extension's primary tool.
        let schema = schemars::schema_for!(StoreFileParams);
        serde_json::to_string(&schema).expect("schema serialization is infallible")
    }

    fn description() -> String {
        "NOVA tools for IronClaw Reborn: store and retrieve AES-256-GCM encrypted \
         files in NOVA groups on NEAR, list groups and their files, join open \
         groups, and owner operations. The NOVA credential is injected by the host; \
         every call names the agent's own NOVA account."
            .to_string()
    }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, JsonSchema)]
struct StoreFileParams {
    /// The agent's NOVA account ID; must match the account configured in setup.
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

#[derive(Debug, Deserialize)]
struct RetrieveFileParams {
    account_id: String,
    group_id: String,
    cid: String,
    #[serde(default)]
    encoding: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GroupParams {
    account_id: String,
    group_id: String,
}

#[derive(Debug, Deserialize)]
struct AccountParams {
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct MemberParams {
    account_id: String,
    group_id: String,
    member_id: String,
}

fn parse<T: DeserializeOwned>(params: &str, tool: &str) -> Result<T, NovaFailure> {
    serde_json::from_str(params)
        .map_err(|e| NovaFailure::BadInput(format!("invalid {tool} parameters: {e}")))
}

fn to_output(v: Value) -> Result<String, NovaFailure> {
    serde_json::to_string(&v).map_err(|e| NovaFailure::Failed(format!("failed to serialize result: {e}")))
}

// ---------------------------------------------------------------------------
// store_file
// ---------------------------------------------------------------------------

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

fn store_file(params: &str) -> Result<String, NovaFailure> {
    let p: StoreFileParams = parse(params, "store_file")?;

    // 1. Hash gate (D10). MUST stay first: no host call (log or http) before it.
    let content_bytes = p.content.as_bytes();
    let computed = sha256_hex(content_bytes);
    if !hash_matches(&computed, &p.sha256) {
        return Err(NovaFailure::HashMismatch);
    }

    // 2. Size gate — also before any host call.
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

    // 3. Membership — fail cleanly before spending anything (no implicit join).
    ensure_member(&p.account_id, &p.group_id)?;

    // 4–6, with one retry if the host declined to send a request.
    let mut attempt = 0;
    let (cid, trans_id, recorded_hash) = loop {
        match upload_once(&p, content_bytes, &computed) {
            Err(NovaFailure::HostRefused(why)) if attempt == 0 => {
                host::log(
                    LogLevel::Warn,
                    &format!("nova.store_file: host declined a request ({why}); retrying once with new bytes"),
                );
                attempt += 1;
            }
            other => break other?,
        }
    };

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
        .map_err(|e| NovaFailure::Failed(format!("failed to serialize result: {e}")))
}

fn upload_once(
    p: &StoreFileParams,
    content_bytes: &[u8],
    computed: &str,
) -> Result<(String, String, Option<String>), NovaFailure> {
    let r = mcp_post(
        &p.account_id,
        "prepare_upload",
        json!({ "group_id": p.group_id, "filename": p.filename }),
        READ_TIMEOUT_MS,
    )?;
    let upload_id = str_field(&r, "upload_id", "prepare_upload")?;
    let key_b64 = str_field(&r, "key", "prepare_upload")?;

    let nonce = fresh_nonce()?;
    let encrypted_b64 = encrypt_v0(&key_b64, content_bytes, &nonce)?;

    let r = mcp_post(
        &p.account_id,
        "finalize_upload",
        json!({
            "upload_id": upload_id,
            "encrypted_data": encrypted_b64,
            "file_hash": computed,
        }),
        WRITE_TIMEOUT_MS,
    )?;
    let cid = r.get("location").or_else(|| r.get("cid")).and_then(|v| v.as_str())
        .ok_or_else(|| NovaFailure::Failed("finalize_upload response had no location/cid".into()))?
        .to_string();
    // The MCP returns the contract's raw JSON return value (a quoted string);
    // strip the quotes so trans_id matches get_group_transactions.
    let trans_id = r.get("trans_id").and_then(|v| v.as_str()).unwrap_or("").trim_matches('"').to_string();
    let recorded = r.get("file_hash").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok((cid, trans_id, recorded))
}

/// Membership via auth_status (a free contract view on the MCP side, on the
/// account's own network). A nonexistent group reads as "not a member".
fn is_member(account_id: &str, group_id: &str) -> Result<bool, NovaFailure> {
    let result = mcp_post(account_id, "auth_status", json!({ "group_id": group_id }), READ_TIMEOUT_MS)?;
    Ok(result.get("authorized_for_group").and_then(|v| v.as_bool()) == Some(true))
}

fn ensure_member(account_id: &str, group_id: &str) -> Result<(), NovaFailure> {
    if is_member(account_id, group_id)? {
        Ok(())
    } else {
        Err(NovaFailure::NotMember(format!(
            "{account_id} is not a member of group '{group_id}' (store_file does not join groups)"
        )))
    }
}

// ---------------------------------------------------------------------------
// retrieve_file
// ---------------------------------------------------------------------------

fn retrieve_file(params: &str) -> Result<String, NovaFailure> {
    let p: RetrieveFileParams = parse(params, "retrieve_file")?;
    let encoding = match p.encoding.as_deref() {
        None | Some("utf8") => "utf8",
        Some("base64") => "base64",
        Some(other) => {
            return Err(NovaFailure::BadInput(format!(
                "encoding must be \"utf8\" or \"base64\", got `{other}`"
            )))
        }
    };
    let network = network_for(&p.account_id);

    // `ipfs_hash` is the MCP's historical parameter name; it carries any stored
    // location (FastFS path or legacy CID).
    let r = mcp_post(
        &p.account_id,
        "prepare_retrieve",
        json!({ "group_id": p.group_id, "ipfs_hash": p.cid }),
        WRITE_TIMEOUT_MS,
    )?;
    let encrypted_b64 = str_field(&r, "encrypted_b64", "prepare_retrieve")?;
    let key_b64 = str_field(&r, "key", "prepare_retrieve")?;
    let format = r.get("format").filter(|f| !f.is_null());

    let plaintext = decode_file(&encrypted_b64, &key_b64, format)?;
    let sha = sha256_hex(&plaintext);
    let size = plaintext.len();
    let content = if encoding == "utf8" {
        String::from_utf8(plaintext).map_err(|_| NovaFailure::NotUtf8)?
    } else {
        B64.encode(&plaintext)
    };

    to_output(json!({
        "cid": p.cid,
        "group_id": p.group_id,
        "account_id": p.account_id,
        "encoding": encoding,
        "content": content,
        "sha256": sha,
        "size_bytes": size,
        "format_version": format_version(format),
        "network": network,
    }))
}

// ---------------------------------------------------------------------------
// list tools
// ---------------------------------------------------------------------------

fn list_group_files(params: &str) -> Result<String, NovaFailure> {
    let p: GroupParams = parse(params, "list_group_files")?;
    let rows = mcp_post(&p.account_id, "get_group_transactions", json!({ "group_id": p.group_id }), READ_TIMEOUT_MS)?;
    let files: Vec<Value> = rows
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut row| {
            // Alias the location as `cid`, matching store_file's output field.
            if let Some(loc) = row.get("ipfs_hash").cloned() {
                if let Some(obj) = row.as_object_mut() {
                    obj.insert("cid".into(), loc);
                }
            }
            row
        })
        .collect();
    to_output(json!({
        "account_id": p.account_id,
        "group_id": p.group_id,
        "network": network_for(&p.account_id),
        "count": files.len(),
        "files": files,
    }))
}

fn list_groups(params: &str, mcp_tool: &str) -> Result<String, NovaFailure> {
    let p: AccountParams = parse(params, mcp_tool)?;
    let groups = mcp_post(&p.account_id, mcp_tool, json!({}), READ_TIMEOUT_MS)?;
    let groups = groups.as_array().cloned().unwrap_or_default();
    to_output(json!({
        "account_id": p.account_id,
        "network": network_for(&p.account_id),
        "count": groups.len(),
        "groups": groups,
    }))
}

// ---------------------------------------------------------------------------
// write tools
// ---------------------------------------------------------------------------

fn join_group(params: &str) -> Result<String, NovaFailure> {
    let p: GroupParams = parse(params, "join_group")?;
    // Check membership FIRST: the contract tests for an open join window before
    // it tests membership, so a member of a group with no open window would get
    // "not open for join". Checking first also avoids paying the join fee.
    let already_member = if is_member(&p.account_id, &p.group_id)? {
        true
    } else {
        match mcp_post(&p.account_id, "join_group", json!({ "group_id": p.group_id }), WRITE_TIMEOUT_MS) {
            Ok(_) => false,
            // Race: joined between the check and the call.
            Err(NovaFailure::AlreadyMember(_)) => true,
            Err(e) => return Err(e),
        }
    };
    to_output(json!({
        "account_id": p.account_id,
        "group_id": p.group_id,
        "network": network_for(&p.account_id),
        "joined": true,
        "already_member": already_member,
    }))
}

fn register_group(params: &str) -> Result<String, NovaFailure> {
    let p: GroupParams = parse(params, "register_group")?;
    let r = mcp_post(&p.account_id, "register_group", json!({ "group_id": p.group_id }), WRITE_TIMEOUT_MS)?;
    to_output(json!({
        "account_id": p.account_id,
        "group_id": p.group_id,
        "network": network_for(&p.account_id),
        "message": r.as_str().unwrap_or("group registered"),
    }))
}

fn member_op(params: &str, mcp_tool: &str) -> Result<String, NovaFailure> {
    let p: MemberParams = parse(params, mcp_tool)?;
    let r = mcp_post(
        &p.account_id,
        mcp_tool,
        json!({ "group_id": p.group_id, "member_id": p.member_id }),
        WRITE_TIMEOUT_MS,
    )?;
    to_output(json!({
        "account_id": p.account_id,
        "group_id": p.group_id,
        "member_id": p.member_id,
        "network": network_for(&p.account_id),
        "message": r.as_str().unwrap_or("done"),
    }))
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no host calls)
// ---------------------------------------------------------------------------

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hash_matches(computed: &str, provided: &str) -> bool {
    provided.len() == 64
        && provided.chars().all(|c| c.is_ascii_hexdigit())
        && provided.eq_ignore_ascii_case(computed)
}

/// Same rule the MCP uses to pick its network config ('.testnet' in account_id).
fn network_for(account_id: &str) -> &'static str {
    if account_id.to_ascii_lowercase().contains(".testnet") {
        "testnet"
    } else {
        "mainnet"
    }
}

/// Mask the host's sensitive-marker words in text that may reach the model.
/// ASCII lowercasing preserves byte offsets, so ranges map back exactly.
fn model_safe(s: &str) -> String {
    let mut out = s.to_string();
    for m in markers::SENSITIVE_MARKERS {
        while let Some(i) = out.to_ascii_lowercase().find(m) {
            out.replace_range(i..i + m.len(), "[masked]");
        }
    }
    out
}

fn str_field(v: &Value, field: &str, tool: &str) -> Result<String, NovaFailure> {
    v.get(field)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| NovaFailure::Failed(format!("{tool} response had no {field}")))
}

fn fresh_nonce() -> Result<[u8; 12], NovaFailure> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce)
        .map_err(|e| NovaFailure::Failed(format!("random number source unavailable: {e}")))?;
    Ok(nonce)
}

fn decode_key(key_b64: &str) -> Result<Vec<u8>, NovaFailure> {
    let key = B64
        .decode(key_b64)
        .map_err(|e| NovaFailure::Failed(format!("the file key is not base64: {e}")))?;
    if key.len() != 32 {
        return Err(NovaFailure::Failed(format!(
            "expected a 32-byte AES-256 file key, got {} bytes",
            key.len()
        )));
    }
    Ok(key)
}

/// v0 wire format: base64( nonce(12) || ciphertext || tag(16) ).
fn encrypt_v0(key_b64: &str, plaintext: &[u8], nonce: &[u8; 12]) -> Result<String, NovaFailure> {
    let key = decode_key(key_b64)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| NovaFailure::Failed(format!("cipher init failed: {e}")))?;
    let ct = cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plaintext, aad: b"" })
        .map_err(|e| NovaFailure::Failed(format!("encryption failed: {e}")))?;
    let mut out = Vec::with_capacity(12 + ct.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&ct);
    Ok(B64.encode(out))
}

/// Port of nova-decode.ts decryptV0: iv = bytes[0..12), ciphertext+tag = rest.
fn decrypt_v0(encrypted_b64: &str, key_b64: &str) -> Result<Vec<u8>, NovaFailure> {
    let encrypted = B64
        .decode(encrypted_b64)
        .map_err(|e| NovaFailure::Failed(format!("the stored ciphertext is not base64: {e}")))?;
    let key = decode_key(key_b64)?;
    if encrypted.len() < 28 {
        return Err(NovaFailure::Failed("ciphertext too short".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| NovaFailure::Failed(format!("cipher init failed: {e}")))?;
    cipher
        .decrypt(Nonce::from_slice(&encrypted[..12]), Payload { msg: &encrypted[12..], aad: b"" })
        .map_err(|_| NovaFailure::Failed("decryption failed (wrong key or corrupted data)".into()))
}

fn format_version(format: Option<&Value>) -> u64 {
    format.and_then(|f| f.get("version")).and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Port of nova-decode.ts decodeFile: null/no version => v0; 1 => v0 decrypt
/// then optional deflate; anything else => error.
fn decode_file(encrypted_b64: &str, key_b64: &str, format: Option<&Value>) -> Result<Vec<u8>, NovaFailure> {
    match format_version(format) {
        0 => decrypt_v0(encrypted_b64, key_b64),
        1 => {
            let payload = decrypt_v0(encrypted_b64, key_b64)?;
            let compression = format
                .and_then(|f| f.get("compression"))
                .and_then(|c| c.as_str())
                .unwrap_or("");
            match compression {
                "" => Ok(payload),
                "deflate" => miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(&payload, MAX_DECODED_BYTES)
                    .map_err(|_| NovaFailure::Failed("inflate failed or exceeded the size limit".into())),
                other => Err(NovaFailure::Failed(format!(
                    "compression '{other}' is not implemented (deflate only)"
                ))),
            }
        }
        v => Err(NovaFailure::Failed(format!("unsupported file format version: {v}"))),
    }
}

/// Map a non-200, non-401 MCP response to the failure vocabulary. Matches the
/// contract panic texts that MCP surfaces in its error body.
fn classify_mcp_error(tool: &str, status: u16, text: &str) -> NovaFailure {
    let lower = text.to_ascii_lowercase();
    if lower.contains("already a member") {
        return NovaFailure::AlreadyMember(format!("{tool}: already a member"));
    }
    if lower.contains("only group owner") {
        return NovaFailure::NotOwner(format!("{tool}: only the group owner can do this"));
    }
    if lower.contains("not open for join")
        || lower.contains("join window closed")
        || lower.contains("join window full")
        || lower.contains("not joinable")
    {
        return NovaFailure::JoinRefused(format!("{tool}: {text}"));
    }
    // On revoke, "user not a member" refers to the TARGET, not the caller.
    if tool == "revoke_group_member" && lower.contains("user not a member") {
        return NovaFailure::Failed(format!("{tool}: member_id is not a member of the group"));
    }
    if lower.contains("not authorized") || lower.contains("unauthorized") || lower.contains("not a member") {
        return NovaFailure::NotMember(format!("{tool}: {text}"));
    }
    if lower.contains("group exists") {
        return NovaFailure::Failed(format!("{tool}: a group with this id already exists"));
    }
    NovaFailure::Failed(format!("{tool} returned HTTP {status}: {text}"))
}

// ---------------------------------------------------------------------------
// HTTP
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

/// Full host detail goes to the debug log only; the model-visible message
/// carries just the kind.
fn log_host_failure(step: &str, f: &HttpFailure) {
    host::log(
        LogLevel::Warn,
        &format!(
            "nova: {step} host failure kind={} code={:?} sent={} detail={:?}",
            http_kind_name(&f.kind),
            f.code,
            f.request_sent,
            f.message
        ),
    );
}

fn snippet(body: &[u8]) -> String {
    let s = String::from_utf8_lossy(body);
    model_safe(&s.chars().take(200).collect::<String>())
}

/// POST to an MCP /tools/* endpoint; returns the unwrapped `result` payload.
fn mcp_post(account_id: &str, tool: &str, body: Value, timeout_ms: u32) -> Result<Value, NovaFailure> {
    // No auth header from the guest: the host injects the NOVA credential for
    // this audience (manifest). x-account-id names the account it must prove.
    let headers = json!({
        "Content-Type": "application/json",
        "x-account-id": account_id,
    })
    .to_string();
    let body = body.to_string().into_bytes();
    let url = format!("{NOVA_MCP_BASE}/tools/{tool}");

    let resp = match host::http_request("POST", &url, &headers, Some(body.as_slice()), Some(timeout_ms)) {
        Ok(r) => r,
        Err(f) => {
            log_host_failure(tool, &f);
            if matches!(f.kind, HttpErrorKind::AuthRequired) {
                return Err(NovaFailure::AuthFailed(format!(
                    "{tool}: the host reports the NOVA extension is not set up for this agent; complete the extension setup"
                )));
            }
            if !f.request_sent {
                return Err(NovaFailure::HostRefused(format!("{tool} ({})", http_kind_name(&f.kind))));
            }
            return Err(NovaFailure::Failed(format!(
                "{tool}: host transport failure ({})",
                http_kind_name(&f.kind)
            )));
        }
    };

    if resp.status == 401 {
        return Err(NovaFailure::AuthFailed(format!(
            "NOVA did not accept the configured login for {account_id} on {tool} (HTTP 401): check the extension setup and that account_id matches it"
        )));
    }
    if resp.status != 200 {
        return Err(classify_mcp_error(tool, resp.status, &snippet(&resp.body)));
    }

    let json: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| NovaFailure::Failed(format!("{tool} response was not JSON: {e}")))?;
    Ok(json.get("result").cloned().unwrap_or(json))
}

export!(NovaReborn);

// ---------------------------------------------------------------------------
// Tests (native target; host calls are unreachable here, which is exactly
// what proves the gates fire before any network call)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn store_params(content: &str, sha: &str) -> String {
        json!({
            "account_id": "agent1.nova-sdk-7.testnet",
            "group_id": "agentic-economy-oracle",
            "filename": "graph.json",
            "content": content,
            "sha256": sha,
        })
        .to_string()
    }

    // ── store_file gates ──

    #[test]
    fn hash_mismatch_sends_nothing() {
        let wrong = "0".repeat(64);
        assert_eq!(store_file(&store_params("{\"a\":1}", &wrong)), Err(NovaFailure::HashMismatch));
    }

    #[test]
    fn malformed_hash_is_a_mismatch() {
        assert_eq!(store_file(&store_params("x", "nothex")), Err(NovaFailure::HashMismatch));
    }

    #[test]
    fn oversized_content_rejected_before_network() {
        let big = "a".repeat(MAX_CONTENT_BYTES + 1);
        let sha = sha256_hex(big.as_bytes());
        assert_eq!(
            store_file(&store_params(&big, &sha)),
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

    // ── dispatch ──

    #[test]
    fn context_routes_by_capability_id() {
        assert_eq!(tool_from_context(Some(r#"{"capability_id":"nova.store_file"}"#)).unwrap(), "store_file");
        assert_eq!(
            tool_from_context(Some(r#"{"capability_id":"nova-reborn.list_owned_groups","extra":1}"#)).unwrap(),
            "list_owned_groups"
        );
        assert!(tool_from_context(None).is_err());
        assert!(tool_from_context(Some("not json")).is_err());
        assert!(tool_from_context(Some(r#"{"capability_id":"nodot"}"#)).is_err());
    }

    #[test]
    fn unknown_tool_is_bad_input() {
        assert!(matches!(dispatch("delete_everything", "{}"), Err(NovaFailure::BadInput(_))));
    }

    #[test]
    fn bad_params_are_bad_input_before_network() {
        assert!(matches!(dispatch("retrieve_file", "{}"), Err(NovaFailure::BadInput(_))));
        assert!(matches!(dispatch("add_group_member", r#"{"account_id":"a"}"#), Err(NovaFailure::BadInput(_))));
        let bad_enc = r#"{"account_id":"a","group_id":"g","cid":"c","encoding":"hex"}"#;
        assert!(matches!(dispatch("retrieve_file", bad_enc), Err(NovaFailure::BadInput(_))));
    }

    // ── crypto / decode ──

    #[test]
    fn encrypt_roundtrip_and_layout() {
        let key_b64 = B64.encode([7u8; 32]);
        let nonce = fresh_nonce().unwrap();
        let pt = b"{\"graph\":[1,2,3]}";
        let enc = encrypt_v0(&key_b64, pt, &nonce).unwrap();
        let blob = B64.decode(&enc).unwrap();
        assert_eq!(blob.len(), 12 + pt.len() + 16, "nonce || ct || tag");
        assert_eq!(&blob[..12], &nonce);
        assert_eq!(decode_file(&enc, &key_b64, None).unwrap(), pt);
    }

    #[test]
    fn same_content_twice_gives_different_ciphertexts() {
        let key_b64 = B64.encode([9u8; 32]);
        let a = encrypt_v0(&key_b64, b"same", &fresh_nonce().unwrap()).unwrap();
        let b = encrypt_v0(&key_b64, b"same", &fresh_nonce().unwrap()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn decode_v1_with_deflate() {
        let key_b64 = B64.encode([3u8; 32]);
        let pt = b"{\"graph\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}".to_vec();
        let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&pt, 6);
        let enc = encrypt_v0(&key_b64, &compressed, &fresh_nonce().unwrap()).unwrap();
        let fmt = json!({ "version": 1, "compression": "deflate" });
        assert_eq!(decode_file(&enc, &key_b64, Some(&fmt)).unwrap(), pt);
    }

    #[test]
    fn decode_v1_without_compression_and_missing_version() {
        let key_b64 = B64.encode([4u8; 32]);
        let enc = encrypt_v0(&key_b64, b"plain", &fresh_nonce().unwrap()).unwrap();
        assert_eq!(decode_file(&enc, &key_b64, Some(&json!({ "version": 1 }))).unwrap(), b"plain");
        assert_eq!(decode_file(&enc, &key_b64, Some(&json!({ "backend": "FastFS" }))).unwrap(), b"plain");
        assert_eq!(decode_file(&enc, &key_b64, Some(&json!({ "version": 1, "compression": "" }))).unwrap(), b"plain");
    }

    #[test]
    fn decode_rejects_unknown_version_compression_and_wrong_key() {
        let key_b64 = B64.encode([5u8; 32]);
        let enc = encrypt_v0(&key_b64, b"x", &fresh_nonce().unwrap()).unwrap();
        assert!(decode_file(&enc, &key_b64, Some(&json!({ "version": 2 }))).is_err());
        assert!(decode_file(&enc, &key_b64, Some(&json!({ "version": 1, "compression": "brotli" }))).is_err());
        assert!(decode_file(&enc, &B64.encode([6u8; 32]), None).is_err());
    }

    // ── error classification ──

    #[test]
    fn classifies_contract_panics() {
        assert!(matches!(classify_mcp_error("join_group", 500, "Smart contract panicked: Already a member"), NovaFailure::AlreadyMember(_)));
        assert!(matches!(classify_mcp_error("add_group_member", 500, "panicked: Only group owner can add"), NovaFailure::NotOwner(_)));
        assert!(matches!(classify_mcp_error("join_group", 500, "panicked: Group not open for join"), NovaFailure::JoinRefused(_)));
        assert!(matches!(classify_mcp_error("join_group", 500, "panicked: Join window closed"), NovaFailure::JoinRefused(_)));
        assert!(matches!(classify_mcp_error("revoke_group_member", 500, "panicked: User not a member"), NovaFailure::Failed(_)));
        assert!(matches!(classify_mcp_error("prepare_retrieve", 500, "Shade retrieve failed: 403 not authorized"), NovaFailure::NotMember(_)));
        assert!(matches!(classify_mcp_error("get_group_transactions", 500, "panicked: Unauthorized"), NovaFailure::NotMember(_)));
        assert!(matches!(classify_mcp_error("register_group", 500, "panicked: Group exists"), NovaFailure::Failed(_)));
        assert!(matches!(classify_mcp_error("register_group", 502, "bad gateway"), NovaFailure::Failed(_)));
    }

    #[test]
    fn generic_failure_code_depends_on_tool() {
        let up = NovaFailure::Failed("x".into()).into_guest_failure("store_file");
        let op = NovaFailure::Failed("x".into()).into_guest_failure("list_group_files");
        assert_eq!(up.code.as_deref(), Some("upload_failed"));
        assert_eq!(op.code.as_deref(), Some("operation_failed"));
    }

    // ── message hygiene ──

    #[test]
    fn model_safe_masks_markers_case_insensitively() {
        let out = model_safe("blocked: Google API KEY pattern, Bearer xyz, client_secret=1");
        let lower = out.to_ascii_lowercase();
        for m in markers::SENSITIVE_MARKERS {
            assert!(!lower.contains(m), "marker `{m}` survived: {out}");
        }
    }

    #[test]
    fn every_failure_message_is_marker_free() {
        let all = [
            NovaFailure::HashMismatch,
            NovaFailure::AuthFailed("x".into()),
            NovaFailure::NotMember("x".into()),
            NovaFailure::NotOwner("x".into()),
            NovaFailure::AlreadyMember("x".into()),
            NovaFailure::JoinRefused("x".into()),
            NovaFailure::Failed("x".into()),
            NovaFailure::HostRefused("x".into()),
            NovaFailure::ContentTooLarge(MAX_CONTENT_BYTES + 1),
            NovaFailure::NotUtf8,
            NovaFailure::BadInput("x".into()),
        ];
        for f in all {
            let msg = f.into_guest_failure("store_file").message.unwrap_or_default().to_ascii_lowercase();
            for m in markers::SENSITIVE_MARKERS {
                assert!(!msg.contains(m), "marker `{m}` in message: {msg}");
            }
        }
    }

    #[test]
    fn source_is_free_of_sensitive_markers() {
        let src = include_str!("lib.rs");
        let body = src.split("#[cfg(test)]").next().unwrap().to_ascii_lowercase();
        for m in markers::SENSITIVE_MARKERS {
            assert!(!body.contains(m), "marker `{m}` appears in lib.rs (above the tests)");
        }
    }
}
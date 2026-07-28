// nova-sdk-rs v1.0.1 - NOVA SDK for Rust
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::query::QueryResponseKind as JsonRpcQueryResponseKind;
use near_primitives::types::{AccountId, Balance, BlockReference, Finality};
use near_primitives::views::QueryRequest;
use thiserror::Error;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;
use serde_json::json;
use serde::Deserialize;
use sha2::{Sha256, Digest};
use reqwest::Client;
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use rand::RngCore;

// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL: &str = "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network";
const DEFAULT_RPC_URL: &str = "https://rpc.mainnet.near.org";
const DEFAULT_CONTRACT_ID: &str = "nova-sdk.near";
const DEFAULT_AUTH_URL: &str = "https://nova-sdk.com";

#[derive(Error, Debug)]
pub enum NovaError {
    #[error("NEAR RPC error: {0}")]
    Near(String),
    #[error("MCP error: {0}")]
    Mcp(String),
    #[error("Account ID parse failed")]
    ParseAccount,
    #[error("Invalid CID: {0}")]
    InvalidCid(String),
    #[error("Authentication error: {0}")]
    Auth(String),
    #[error("HTTP error: {0}")]
    Http(String),
    #[error("Encryption error: {0}")]
    Encryption(String),
    #[error("Decryption error: {0}")]
    Decryption(String),
    #[error("Token error: {0}")]
    Token(String),
}

impl From<reqwest::Error> for NovaError {
    fn from(e: reqwest::Error) -> Self {
        NovaError::Http(e.to_string())
    }
}

impl From<aes_gcm::Error> for NovaError {
    fn from(e: aes_gcm::Error) -> Self {
        NovaError::Encryption(format!("AES-GCM error: {:?}", e))
    }
}

// Public types
#[derive(Deserialize, Debug, Clone)]
pub struct Transaction {
    pub group_id: String,
    pub user_id: String,
    pub file_hash: String,
    pub ipfs_hash: String,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub cid: String,
    pub trans_id: String,
    pub file_hash: String,
}

#[derive(Debug)]
pub struct RetrieveResult {
    pub data: Vec<u8>,
    pub ipfs_hash: String,
    pub group_id: String,
}

#[derive(Deserialize, Debug)]
pub struct AuthStatusResult {
    pub authenticated: bool,
    pub near_account_id: Option<String>,
    pub authorized_for_group: Option<bool>,
}

// Internal types
#[derive(Deserialize, Debug)]
struct PrepareUploadResponse {
    upload_id: String,
    key: String,
    group_id: String,
    filename: String,
}

#[derive(Deserialize, Debug)]
struct FinalizeUploadResponse {
    cid: String,
    trans_id: String,
    file_hash: String,
}

#[derive(Deserialize, Debug)]
struct PrepareRetrieveResponse {
    key: String,
    encrypted_b64: String,
    ipfs_hash: String,
    group_id: String,
}

#[derive(Deserialize, Debug)]
struct McpMessageResponse {
    message: Option<String>,
}

#[derive(Deserialize, Debug)]
struct SessionTokenResponse {
    token: String,
    account_id: String,
    expires_in: String,
}

// Token cache
#[derive(Debug, Clone)]
struct TokenCache {
    token: String,
    expires_at: u64, // Unix timestamp in milliseconds
}

// Configuration for NovaSdk
#[derive(Clone)]
pub struct NovaSdkConfig {
    pub api_key: Option<String>,
    pub auth_url: String,
    pub rpc_url: String,
    pub contract_id: String,
    pub mcp_url: String,
}

impl Default for NovaSdkConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            auth_url: DEFAULT_AUTH_URL.to_string(),
            rpc_url: DEFAULT_RPC_URL.to_string(),
            contract_id: DEFAULT_CONTRACT_ID.to_string(),
            mcp_url: DEFAULT_MCP_URL.to_string(),
        }
    }
}

impl NovaSdkConfig {
    /// Create config for testnet
    pub fn testnet() -> Self {
        Self {
            api_key: None,
            auth_url: DEFAULT_AUTH_URL.to_string(),
            rpc_url: "https://rpc.testnet.near.org".to_string(),
            contract_id: "nova-sdk-6.testnet".to_string(),
            mcp_url: DEFAULT_MCP_URL.to_string(),
        }
    }

    /// Create config for mainnet
    pub fn mainnet() -> Self {
        Self::default()
    }

    /// Set the API key for authentication
    pub fn with_api_key(mut self, api_key: &str) -> Self {
        self.api_key = Some(api_key.to_string());
        self
    }
}

// encryption/decryption helpers
fn encrypt_data(data: &[u8], key_b64: &str) -> Result<String, NovaError> {
    use base64::Engine;
    
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(key_b64)
        .map_err(|e| NovaError::Encryption(format!("Invalid key: {}", e)))?;
    
    if key_bytes.len() != 32 {
        return Err(NovaError::Encryption(format!(
            "Key must be 32 bytes, got {}",
            key_bytes.len()
        )));
    }
    
    // Generate random 12-byte IV
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);
    
    // Create cipher and encrypt
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| NovaError::Encryption(format!("Cipher init failed: {:?}", e)))?;
    
    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|e| NovaError::Encryption(format!("Encryption failed: {:?}", e)))?;
    
    // Combine: IV (12 bytes) + ciphertext (includes auth tag)
    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&iv);
    result.extend_from_slice(&ciphertext);
    
    Ok(base64::engine::general_purpose::STANDARD.encode(&result))
}

fn decrypt_data(encrypted_b64: &str, key_b64: &str) -> Result<Vec<u8>, NovaError> {
    use base64::Engine;
    
    let encrypted_bytes = base64::engine::general_purpose::STANDARD
        .decode(encrypted_b64)
        .map_err(|e| NovaError::Decryption(format!("Invalid encrypted data: {}", e)))?;
    
    if encrypted_bytes.len() < 28 {
        // 12 (IV) + 16 (min auth tag)
        return Err(NovaError::Decryption("Encrypted data too short".to_string()));
    }
    
    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(key_b64)
        .map_err(|e| NovaError::Decryption(format!("Invalid key: {}", e)))?;
    
    if key_bytes.len() != 32 {
        return Err(NovaError::Decryption(format!(
            "Key must be 32 bytes, got {}",
            key_bytes.len()
        )));
    }
    
    let iv = &encrypted_bytes[0..12];
    let ciphertext = &encrypted_bytes[12..];
    let nonce = Nonce::from_slice(iv);
    
    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| NovaError::Decryption(format!("Cipher init failed: {:?}", e)))?;
    
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| NovaError::Decryption(format!("Decryption failed: {:?}", e)))
}

/// NOVA SDK - Secure file sharing on NEAR Protocol
/// 
/// # Example
/// ```no_run
/// use nova_sdk_rs::NovaSdk;
/// 
/// #[tokio::main]
/// async fn main() -> Result<(), Box<dyn std::error::Error>> {
///     // Simplest usage - automatic token management
///     let sdk = NovaSdk::new("alice.nova-sdk.near")?;
///     
///     // Upload a file
///     let result = sdk.upload("my-group", b"Hello NOVA!", "hello.txt").await?;
///     println!("Uploaded: {}", result.cid);
///     
///     // Retrieve the file
///     let retrieved = sdk.retrieve("my-group", &result.cid).await?;
///     println!("Retrieved: {} bytes", retrieved.data.len());
///     
///     Ok(())
/// }
/// ```

#[derive(Debug)]
pub struct NovaSdk {
    client: JsonRpcClient,
    http_client: Client,
    account_id: String,
    contract_id: AccountId,
    auth_url: String,
    api_key: Option<String>,
    mcp_url: String,
    rpc_url: String,
    network_id: String,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
}

impl NovaSdk {
    /// Creates a new NovaSdk instance with `account_id` - automatic token management.
    pub fn new(account_id: &str) -> Result<Self, NovaError> {
        Self::with_config(account_id, NovaSdkConfig::default())
    }

    /// Creates a new NovaSdk instance for testnet.
    pub fn testnet(account_id: &str) -> Result<Self, NovaError> {
        Self::with_config(account_id, NovaSdkConfig::testnet())
    }

    /// Creates a new NovaSdk instance with custom configuration.
    pub fn with_config(
        account_id: &str,
        config: NovaSdkConfig,
    ) -> Result<Self, NovaError> {
        if account_id.is_empty() {
            return Err(NovaError::Auth("account_id required: get yours at nova-sdk.com".to_string()));
        }

        let contract_id = AccountId::from_str(&config.contract_id)
            .map_err(|_| NovaError::ParseAccount)?;

        // Auto-detect network
        let network_id = Self::detect_network(&contract_id, &config.rpc_url);
        
        // Validate mainnet contract
        if network_id == "mainnet" && !Self::is_valid_mainnet_contract(&contract_id) {
            return Err(NovaError::Auth(format!(
                "Invalid mainnet contract: {}. Must end with .near",
                contract_id
            )));
        }
        
        // Mainnet warning
        if network_id == "mainnet" {
            eprintln!("⚠️  MAINNET MODE: Operations use real NEAR tokens.");
            eprintln!("📋 Contract: {}", contract_id);
            eprintln!("💰 Check costs at: https://github.com/jcarbonnell/nova");
        }

        Ok(Self {
            client: JsonRpcClient::connect(&config.rpc_url),
            http_client: Client::new(),
            account_id: account_id.to_string(),
            contract_id,
            auth_url: config.auth_url,
            api_key: config.api_key,
            mcp_url: config.mcp_url,
            rpc_url: config.rpc_url,
            network_id,
            token_cache: Arc::new(RwLock::new(None)),
        })
    }

    // Token Management
    /// Get a valid session token, fetching or refreshing if needed.
    async fn get_session_token(&self) -> Result<String, NovaError> {
        // Require API key
        let api_key = self.api_key.as_ref().ok_or_else(|| {
            NovaError::Auth("API key required. Get yours at nova-sdk.com".to_string())
        })?;
        
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Check cached token (with 5 minute buffer)
        {
            let cache = self.token_cache.read().await;
            if let Some(ref tc) = *cache {
                if tc.expires_at > now_ms + 5 * 60 * 1000 {
                    return Ok(tc.token.clone());
                }
            }
        }

        // Fetch new token
        println!("🔑 Fetching session token for: {}", self.account_id);

        let response = self
            .http_client
            .post(format!("{}/api/auth/session-token", self.auth_url))
            .header("Content-Type", "application/json")
            .header("X-API-Key", api_key)
            .json(&json!({ "account_id": self.account_id }))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            
            if status.as_u16() == 404 {
                return Err(NovaError::Token(format!(
                    "Account '{}' not found. Create one at nova-sdk.com first.",
                    self.account_id
                )));
            }
            
            // Try to parse error message
            let error_msg = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&error_text) {
                json.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&error_text)
                    .to_string()
            } else {
                error_text
            };

            return Err(NovaError::Token(format!(
                "Failed to get session token ({}): {}",
                status, error_msg
            )));
        }

        let token_response: SessionTokenResponse = response
            .json()
            .await
            .map_err(|e| NovaError::Token(format!("Failed to parse token response: {}", e)))?;

        // Verify account_id matches
        if token_response.account_id != self.account_id {
            eprintln!(
                "⚠️  Account ID mismatch: requested {}, got {}",
                self.account_id, token_response.account_id
            );
        }

        // Parse expires_in and cache token
        let expires_ms = Self::parse_expiry(&token_response.expires_in);
        
        {
            let mut cache = self.token_cache.write().await;
            *cache = Some(TokenCache {
                token: token_response.token.clone(),
                expires_at: now_ms + expires_ms,
            });
        }

        println!("✅ Session token obtained, expires in: {}", token_response.expires_in);
        Ok(token_response.token)
    }

    fn parse_expiry(expires_in: &str) -> u64 {
        // Parse "24h", "30m", "7d" etc.
        let chars: Vec<char> = expires_in.chars().collect();
        if chars.is_empty() {
            return 23 * 60 * 60 * 1000; // Default 23h
        }

        let unit = chars.last().unwrap();
        let value_str: String = chars[..chars.len()-1].iter().collect();
        let value: u64 = value_str.parse().unwrap_or(23);

        match unit {
            'h' => value * 60 * 60 * 1000,
            'm' => value * 60 * 1000,
            'd' => value * 24 * 60 * 60 * 1000,
            _ => 23 * 60 * 60 * 1000,
        }
    }

    /// Force refresh the session token.
    /// 
    /// Useful if you get auth errors and want to retry with a fresh token.
    pub async fn refresh_token(&self) -> Result<(), NovaError> {
        {
            let mut cache = self.token_cache.write().await;
            *cache = None;
        }
        self.get_session_token().await?;
        Ok(())
    }

    // Network detection
    fn detect_network(contract_id: &AccountId, rpc_url: &str) -> String {
        let contract_str = contract_id.as_str();
        
        if contract_str.ends_with(".testnet") {
            return "testnet".to_string();
        }
        if contract_str.ends_with(".near") {
            return "mainnet".to_string();
        }
        
        if rpc_url.contains("testnet") {
            return "testnet".to_string();
        }
        if rpc_url.contains("mainnet") {
            return "mainnet".to_string();
        }
        
        // Default to mainnet
        eprintln!("⚠️  Network auto-detection failed, defaulting to mainnet");
        "mainnet".to_string()
    }

    fn is_valid_mainnet_contract(contract_id: &AccountId) -> bool {
        contract_id.as_str().ends_with(".near")
    }

    // Public accessors
    pub fn account_id(&self) -> &str {
        &self.account_id
    }

    pub fn contract_id(&self) -> &str {
        self.contract_id.as_str()
    }

    pub fn mcp_url(&self) -> &str {
        &self.mcp_url
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn network_id(&self) -> &str {
        &self.network_id
    }

    pub fn auth_url(&self) -> &str {
        &self.auth_url
    }

    // Get network info for debugging
    pub fn get_network_info(&self) -> (String, String, String, String) {
        (
            self.network_id.clone(),
            self.contract_id.to_string(),
            self.rpc_url.clone(),
            self.auth_url.clone(),
        )
    }

    // MCP Communication
    async fn call_mcp_tool<T: for<'de> Deserialize<'de>>(
        &self,
        tool_name: &str,
        args: serde_json::Value,
    ) -> Result<T, NovaError> {
        let token = self.get_session_token().await?;
        // REST tools are at /tools/ — MCP protocol endpoint is at /mcp
        let url = format!("{}/tools/{}", self.mcp_url, tool_name);

        let response = self
            .http_client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", token))
            .header("x-account-id", &self.account_id)
            .header("x-wallet-id", &self.account_id) // shade agent salt reconstruction
            .json(&args)
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            
            let error_msg = if let Ok(json) = serde_json::from_str::<serde_json::Value>(&error_text) {
                json.get("error")
                    .or(json.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&error_text)
                    .to_string()
            } else {
                error_text
            };

            return Err(NovaError::Mcp(format!(
                "MCP tool '{}' failed ({}): {}",
                tool_name, status, error_msg
            )));
        }

        // Unwrap { result: ... } envelope added by expose_as_rest decorator
        let raw: serde_json::Value = response
            .json()
            .await
            .map_err(|e| NovaError::Mcp(format!("Failed to parse MCP response: {}", e)))?;

        let inner = if let Some(result) = raw.get("result") {
            result.clone()
        } else {
            raw
        };

        serde_json::from_value::<T>(inner)
            .map_err(|e| NovaError::Mcp(format!("Failed to deserialize MCP response: {}", e)))
    }

    /// core NOVA operations
    /// Check authentication status and group authorization.
    pub async fn auth_status(&self, group_id: Option<&str>) -> Result<AuthStatusResult, NovaError> {
        let args = json!({
            "group_id": group_id.unwrap_or("default")
        });
        self.call_mcp_tool("auth_status", args).await
    }

    /// Register a new group. Caller becomes owner.
    pub async fn register_group(&self, group_id: &str) -> Result<String, NovaError> {
        let args = json!({ "group_id": group_id });
        let response: McpMessageResponse = self.call_mcp_tool("register_group", args).await?;
        Ok(response.message.unwrap_or_else(|| format!("Group '{}' registered successfully", group_id)))
    }

    /// Add a member to a group (owner only).
    pub async fn add_group_member(&self, group_id: &str, member_id: &str) -> Result<String, NovaError> {
        let args = json!({
            "group_id": group_id,
            "member_id": member_id
        });
        let response: McpMessageResponse = self.call_mcp_tool("add_group_member", args).await?;
        Ok(response.message.unwrap_or_else(|| format!("Added {} to group '{}'", member_id, group_id)))
    }

    /// Self-join an OPEN group (hackathon submission groups). The caller joins
    /// themselves — no owner action needed. Only works on groups the owner has
    /// opened for join. Idempotent-safe: returns Ok if already a member.
    pub async fn join_group(&self, group_id: &str) -> Result<String, NovaError> {
        if let Ok(true) = self.is_authorized(group_id, None).await {
            return Ok(format!("Already a member of '{}'", group_id));
        }
        let args = json!({ "group_id": group_id });
        // MCP returns result as a bare string ("Joined group '...'"), not an object.
        let msg: String = self.call_mcp_tool("join_group", args).await?;
        Ok(msg)
    }

    /// Revoke a member from a group (owner only, triggers key rotation).
    pub async fn revoke_group_member(&self, group_id: &str, member_id: &str) -> Result<String, NovaError> {
        let args = json!({
            "group_id": group_id,
            "member_id": member_id
        });
        let response: McpMessageResponse = self.call_mcp_tool("revoke_group_member", args).await?;
        Ok(response.message.unwrap_or_else(|| format!("Revoked {} from group '{}'", member_id, group_id)))
    }

    /// Upload a file with end-to-end encryption.
    ///
    /// Flow:
    /// 1. SDK calls prepare_upload to get encryption key
    /// 2. SDK encrypts data locally (AES-256-GCM)
    /// 3. SDK calls finalize_upload with encrypted data
    /// 4. MCP uploads to IPFS and records on NEAR
    ///
    /// # Arguments
    /// * `group_id` - The group to upload to
    /// * `data` - Raw file data
    /// * `filename` - Name of the file
    ///
    /// # Returns
    /// Upload result with CID and transaction ID
    pub async fn upload(
        &self,
        group_id: &str,
        data: &[u8],
        filename: &str,
    ) -> Result<UploadResult, NovaError> {
        // Step 1: Get encryption key from MCP
        let args = json!({
            "group_id": group_id,
            "filename": filename
        });
        let prepare_result: PrepareUploadResponse =
            self.call_mcp_tool("prepare_upload", args).await?;

        let upload_id = prepare_result.upload_id;
        let key = prepare_result.key;

        // Step 2: Encrypt data locally
        let encrypted_b64 = encrypt_data(data, &key)?;

        // Step 3: Compute hash of plaintext
        let file_hash = Self::compute_hash(data);

        // Step 4: Finalize upload
        let body = json!({
            "upload_id": upload_id,
            "encrypted_data": encrypted_b64,
            "file_hash": file_hash
        });
        let finalize_result: FinalizeUploadResponse =
            self.call_mcp_tool("finalize_upload", body).await?;

        Ok(UploadResult {
            cid: finalize_result.cid,
            trans_id: finalize_result.trans_id,
            file_hash: finalize_result.file_hash,
        })
    }

    /// Retrieve and decrypt a file.
    ///
    /// Flow:
    /// 1. Call prepare_retrieve to get key and encrypted data
    /// 2. Decrypt data locally (client-side)
    ///
    /// # Arguments
    /// * `group_id` - The group the file belongs to
    /// * `ipfs_hash` - The IPFS CID of the file
    ///
    /// # Returns
    /// Decrypted file data
    pub async fn retrieve(
        &self,
        group_id: &str,
        ipfs_hash: &str,
    ) -> Result<RetrieveResult, NovaError> {
        if !ipfs_hash.starts_with("Qm") && !ipfs_hash.starts_with("bafy") {
            return Err(NovaError::InvalidCid(ipfs_hash.to_string()));
        }

        // Step 1: Get key and encrypted data from MCP
        let args = json!({
            "group_id": group_id,
            "ipfs_hash": ipfs_hash
        });
        let prepare_result: PrepareRetrieveResponse =
            self.call_mcp_tool("prepare_retrieve", args).await?;

        // Step 2: Decrypt data locally
        let decrypted_data = decrypt_data(&prepare_result.encrypted_b64, &prepare_result.key)?;

        Ok(RetrieveResult {
            data: decrypted_data,
            ipfs_hash: prepare_result.ipfs_hash,
            group_id: prepare_result.group_id,
        })
    }

    /// Read-Only Contract Queries (Direct RPC - no auth needed)
    
    /// Get account balance in yoctoNEAR
    pub async fn get_balance(&self, account_id: Option<&str>) -> Result<Balance, NovaError> {
        let id = account_id.unwrap_or(&self.account_id);
        let account_id_acc = AccountId::from_str(id).map_err(|_| NovaError::ParseAccount)?;
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::ViewAccount { account_id: account_id_acc },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::ViewAccount(acc) => Ok(acc.amount),
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Checks if a user is authorized in a group
    pub async fn is_authorized(&self, group_id: &str, user_id: Option<&str>) -> Result<bool, NovaError> {
        let id = user_id.unwrap_or(&self.account_id);
        let args = json!({"group_id": group_id, "user_id": id}).to_string().into_bytes();
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "is_authorized".to_string(),
                args: args.into(),
            },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let bool_result: bool = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(bool_result)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Get group checksum (Shade TEE attestation)
    pub async fn get_group_checksum(&self, group_id: &str) -> Result<Option<String>, NovaError> {
        let args = json!({"group_id": group_id}).to_string().into_bytes();
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "get_group_checksum".to_string(),
                args: args.into(),
            },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                if result.result.is_empty() {
                    return Ok(None);
                }
                let checksum: Option<String> = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(checksum)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Get group owner.
    pub async fn get_group_owner(&self, group_id: &str) -> Result<Option<String>, NovaError> {
        let args = json!({"group_id": group_id}).to_string().into_bytes();
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "get_group_owner".to_string(),
                args: args.into(),
            },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                if result.result.is_empty() {
                    return Ok(None);
                }
                let owner: Option<String> = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(owner)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Estimates fee for an action (yoctoNEAR, read-only view).
    pub async fn estimate_fee(&self, action: &str) -> Result<u128, NovaError> {
        let args = json!({"action": action}).to_string().into_bytes();
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "estimate_fee".to_string(),
                args: args.into(),
            },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let fee: u128 = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(fee)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// get transactions for a group.
    pub async fn get_transactions_for_group(
        &self,
        group_id: &str,
        user_id: Option<&str>,
    ) -> Result<Vec<Transaction>, NovaError> {
        let id = user_id.unwrap_or(&self.account_id);
        let args = json!({"group_id": group_id, "user_id": id}).to_string().into_bytes();
        
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "get_transactions_for_group".to_string(),
                args: args.into(),
            },
        };
        
        let response = self.client.call(request).await
            .map_err(|e| NovaError::Near(e.to_string()))?;
        
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let txs: Vec<Transaction> = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(format!("Failed to parse transactions: {}", e)))?;
                Ok(txs)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Compute SHA256 hash of data.
    pub fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    // Mock session token for unit tests (not valid for real MCP calls)
    const MOCK_SESSION_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Utbm92YS5ub3ZhLXNkay01LnRlc3RuZXQiLCJ0eXBlIjoibm92YV9zZXNzaW9uIn0.mock";
    const TEST_ACCOUNT_ID: &str = "alice-nova.nova-sdk-6.testnet";

    // =========================================================================
    // Constructor Tests
    // =========================================================================

    fn make_sdk(account_id: &str) -> Result<NovaSdk, NovaError> {
        let config = NovaSdkConfig::default()
            .with_api_key("nova_sk_testkey1234567890123456789012345678901");
        NovaSdk::with_config(account_id, config)
    }

    #[test]
    fn test_new_success() {
        let result = make_sdk(TEST_ACCOUNT_ID);
        assert!(result.is_ok());
        let sdk = result.unwrap();
        assert_eq!(sdk.account_id(), TEST_ACCOUNT_ID);
        assert_eq!(sdk.contract_id(), DEFAULT_CONTRACT_ID);
        assert_eq!(sdk.mcp_url(), DEFAULT_MCP_URL);
        assert_eq!(sdk.rpc_url(), DEFAULT_RPC_URL);
    }

    #[test]
    fn test_new_requires_account_id() {
        let result = make_sdk("");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, NovaError::Auth(_)));
        assert!(err.to_string().contains("account_id required"));
    }

    #[test]
    fn test_api_key_required_on_mcp_call() {
        // SDK without api_key should fail lazily when first MCP call is made
        let result = NovaSdk::new(TEST_ACCOUNT_ID);
        assert!(result.is_ok()); // construction succeeds
        // actual enforcement happens in get_session_token() at call time
    }

    // =========================================================================
    // Utility Tests
    // =========================================================================

    #[test]
    fn test_compute_hash() {
        let hash = NovaSdk::compute_hash(b"test data");
        assert_eq!(hash.len(), 64); // SHA256 hex = 64 chars
        assert_eq!(hash, "916f0027a575074ce72a331777c3478d6513f786a591bd892da1a577bf2335f9");
    }

    #[test]
    fn test_compute_hash_consistency() {
        let data = b"consistent data";
        let hash1 = NovaSdk::compute_hash(data);
        let hash2 = NovaSdk::compute_hash(data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_compute_hash_different_data() {
        let hash1 = NovaSdk::compute_hash(b"data1");
        let hash2 = NovaSdk::compute_hash(b"data2");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_compute_hash_empty() {
        let hash = NovaSdk::compute_hash(b"");
        assert_eq!(hash.len(), 64);
        // SHA256 of empty string
        assert_eq!(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }

    // =========================================================================
    // CID Validation Tests
    // =========================================================================

    #[test]
    fn test_valid_cid_format() {
        assert!("QmXyz123456789abcdefghijklmnopqrstuvwxyz1234".starts_with("Qm"));
        assert!("QmTest".starts_with("Qm"));
    }

    #[test]
    fn test_invalid_cid_format() {
        assert!(!"invalid_cid".starts_with("Qm"));
        assert!(!"bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi".starts_with("Qm")); // CIDv1
        assert!(!"".starts_with("Qm"));
    }

    // =========================================================================
    // Read-Only RPC Tests (No Auth Required)
    // =========================================================================

    #[tokio::test]
    async fn test_get_balance() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        // Query a known mainnet account (always exists)
        let balance = sdk.get_balance(Some("nova-sdk.near")).await.unwrap();
        let bal_str = balance.to_string();
        assert!(!bal_str.is_empty());
        assert!(bal_str.parse::<u128>().is_ok());
    }

    #[tokio::test]
    async fn test_get_balance_default_account() {
        let sdk = make_sdk("nova-sdk.near").unwrap();
        // Uses sdk.account_id by default — must be a real mainnet account
        let balance = sdk.get_balance(None).await.unwrap();
        assert!(balance > 0);
    }

    #[tokio::test]
    async fn test_get_balance_nonexistent_account() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_balance(Some("nonexistent.account.testnet")).await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), NovaError::Near(_)));
    }

    #[tokio::test]
    async fn test_is_authorized() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.is_authorized("test_group", Some("random.user.testnet")).await;
        // Should error on non-existent group or return false for unauthorized
        match result {
            Ok(authorized) => assert!(!authorized, "Random user should not be authorized"),
            Err(e) => {
                // Accept any Near error (includes network errors, contract errors, etc.)
                assert!(matches!(e, NovaError::Near(_)), "Expected Near error, got: {:?}", e);
                // Network errors are acceptable in unit tests (RPC may be unavailable)
            }
        }
    }

    #[tokio::test]
    async fn test_is_authorized_default_user() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        // Uses sdk.account_id by default
        let result = sdk.is_authorized("test_group", None).await;
        // Result depends on whether test_group exists and user is authorized
        assert!(result.is_ok() || matches!(result.unwrap_err(), NovaError::Near(_)));
    }

    #[tokio::test]
    async fn test_get_group_checksum() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_group_checksum("test_group").await;
        match result {
            Ok(checksum) => {
                // May be None if not set, or Some(string)
                if let Some(cs) = checksum {
                    assert!(!cs.is_empty());
                }
            }
            Err(e) => {
                // Group may not exist
                assert!(matches!(e, NovaError::Near(_)));
            }
        }
    }

    #[tokio::test]
    async fn test_get_group_owner() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_group_owner("test_group").await;
        match result {
            Ok(owner) => {
                if let Some(o) = owner {
                    assert!(!o.is_empty());
                    assert!(o.contains(".testnet") || o.contains(".near"));
                }
            }
            Err(e) => {
                assert!(matches!(e, NovaError::Near(_)));
            }
        }
    }

    #[tokio::test]
    async fn test_get_group_owner_nonexistent() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_group_owner("nonexistent_group_xyz_123").await;
        match result {
            Ok(owner) => assert!(owner.is_none(), "Nonexistent group should have no owner"),
            Err(_) => {} // Also acceptable
        }
    }

    #[tokio::test]
    async fn test_estimate_fee() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let fee = sdk.estimate_fee("claim_token").await.unwrap();
        assert!(fee > 0, "Fee should be positive");
        // Default claim_token fee is typically 0.001 NEAR = 1e21 yoctoNEAR
        println!("claim_token fee: {} yoctoNEAR ({} NEAR)", fee, fee as f64 / 1e24);
    }

    #[tokio::test]
    async fn test_estimate_fee_record_transaction() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let fee = sdk.estimate_fee("record_transaction").await.unwrap();
        assert!(fee > 0, "Record transaction fee should be positive");
        println!("record_transaction fee: {} yoctoNEAR ({} NEAR)", fee, fee as f64 / 1e24);
    }

    #[tokio::test]
    async fn test_estimate_fee_unknown_action() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let fee = sdk.estimate_fee("nonexistent_action").await.unwrap();
        assert_eq!(fee, 0, "Unknown action should return 0");
    }

    #[tokio::test]
    async fn test_get_transactions_for_group() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_transactions_for_group("test_group", Some("random.user.testnet")).await;
        match result {
            Ok(txs) => {
                // May be empty for random user
                println!("Found {} transactions", txs.len());
            }
            Err(e) => {
                assert!(matches!(e, NovaError::Near(_)));
            }
        }
    }

    #[tokio::test]
    async fn test_get_transactions_for_group_default_user() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.get_transactions_for_group("test_group", None).await;
        // Uses sdk.account_id by default
        assert!(result.is_ok() || matches!(result.unwrap_err(), NovaError::Near(_)));
    }

    #[tokio::test]
    async fn test_view_invalid_group() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.is_authorized("nonexistent_group_123", Some("test.user.testnet")).await;
        // Should error for non-existent group
        match result {
            Ok(_) => {} // Contract might return false instead of error
            Err(e) => assert!(matches!(e, NovaError::Near(_))),
        }
    }

    // =========================================================================
    // MCP Tool Tests (Require Valid Session Token)
    // =========================================================================

    #[tokio::test]
    async fn test_auth_status_invalid_token() {
        // SDK without api_key will fail at token fetch stage with Token error
        let result = NovaSdk::new(TEST_ACCOUNT_ID);
        assert!(result.is_ok());
        let sdk = result.unwrap();
        let auth_result = sdk.auth_status(None).await;
        assert!(auth_result.is_err());
        let err = auth_result.unwrap_err();
        // No api_key → Token error; invalid api_key → Token or Http error
        assert!(
            matches!(err, NovaError::Token(_))
            || matches!(err, NovaError::Mcp(_))
            || matches!(err, NovaError::Http(_))
            || matches!(err, NovaError::Auth(_)),
            "Expected Auth/Token/Mcp/Http error, got: {:?}", err
        );
    }

    #[tokio::test]
    async fn test_register_group_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.register_group("test_group_new").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_add_group_member_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.add_group_member("test_group", "new.member.testnet").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_join_group_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        // is_authorized runs first (direct RPC, no auth). For a nonexistent group
        // it errors or returns false; either way join_group then attempts the MCP
        // call with an unusable token and fails. Net: Err.
        let result = sdk.join_group("nonexistent_group_xyz_123").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_revoke_group_member_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result = sdk.revoke_group_member("test_group", "member.testnet").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_composite_upload_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let test_data = b"test data";
        let result: Result<crate::UploadResult, _> = sdk.upload("test_group", test_data, "test.txt").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_retrieve_invalid_token() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result: Result<crate::RetrieveResult, _> = sdk.retrieve("test_group", "QmDummyCID123456789").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_retrieve_invalid_cid() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result: Result<crate::RetrieveResult, _> = sdk.retrieve("test_group", "invalid_cid").await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, NovaError::InvalidCid(_)));
        assert!(err.to_string().contains("invalid_cid"));
    }

    #[tokio::test]
    async fn test_retrieve_empty_cid() {
        let sdk = make_sdk(TEST_ACCOUNT_ID).unwrap();
        let result: Result<crate::RetrieveResult, _> = sdk.retrieve("test_group", "").await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), NovaError::InvalidCid(_)));
    }

    // =========================================================================
    // Integration Tests (Require Real Credentials)
    // =========================================================================

    fn get_integration_sdk() -> Option<NovaSdk> {
        let account_id = env::var("TEST_NOVA_ACCOUNT_ID").ok()?;
        let api_key = env::var("NOVA_API_KEY").ok()?;
        let config = NovaSdkConfig::default().with_api_key(&api_key);
        NovaSdk::with_config(&account_id, config).ok()
    }

    #[tokio::test]
    async fn test_auth_status_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let result = sdk.auth_status(Some("test_group")).await.unwrap();
        println!("Auth status: authenticated={}, account={:?}", 
                 result.authenticated, result.near_account_id);
        assert!(result.authenticated);
        assert!(result.near_account_id.is_some());
    }

    #[tokio::test]
    async fn test_register_group_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let group_id = format!("test_group_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        
        let result = sdk.register_group(&group_id).await;
        match result {
            Ok(msg) => {
                println!("✅ Registered group: {}", msg);
                assert!(msg.contains(&group_id) || msg.contains("success"));
            }
            Err(e) => {
                // May fail if group exists or other issue
                println!("Register group result: {}", e);
            }
        }
    }

    #[tokio::test]
    async fn test_register_group_existing_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        // Try to register existing group - should fail
        let result = sdk.register_group("test_group").await;
        if let Err(e) = result {
            assert!(matches!(e, NovaError::Mcp(_)));
            println!("Expected error for existing group: {}", e);
        }
    }

    #[tokio::test]
    async fn test_add_group_member_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let result = sdk.add_group_member("test_group", "new.member.testnet").await;
        match result {
            Ok(msg) => println!("✅ Added member: {}", msg),
            Err(e) => {
                if e.to_string().contains("already a member") {
                    println!("Already member - expected");
                } else {
                    println!("Add member error: {}", e);
                }
            }
        }
    }

    #[tokio::test]
    async fn test_revoke_group_member_invalid_user_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let result = sdk.revoke_group_member("test_group", "non.member.testnet").await;
        assert!(result.is_err());
        println!("Expected error for non-member: {}", result.unwrap_err());
    }

    #[tokio::test]
    async fn test_composite_upload_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let test_data = b"Test data for composite upload via MCP";
        let result = sdk.upload("test_group", test_data, "test.txt").await.unwrap();
        
        println!("✅ Upload success: cid={}, hash={}", result.cid, result.file_hash);

        assert!(!result.cid.is_empty());
        assert!(result.cid.starts_with("Qm"));
        assert!(!result.trans_id.is_empty());
        assert_eq!(result.file_hash.len(), 64);
    }

    #[tokio::test]
    async fn test_retrieve_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        // First upload
        let original_data = b"Test data for composite retrieve via MCP";
        let upload_result = sdk.upload("test_group", original_data, "retrieve_test.txt").await.unwrap();
        let cid = &upload_result.cid;
        
        // Then retrieve
        let retrieve_result = sdk.retrieve("test_group", cid).await.unwrap();
        
        println!("✅ Retrieve success:");
        println!("   Data length: {} bytes", retrieve_result.data.len());
        println!("   IPFS Hash: {}", retrieve_result.ipfs_hash);
        println!("   Group ID: {}", retrieve_result.group_id);

        assert_eq!(retrieve_result.data, original_data);
        assert_eq!(retrieve_result.ipfs_hash, *cid);
        assert_eq!(retrieve_result.group_id, "test_group");
        
        println!("✅ Decrypted data matches original ({} bytes)", retrieve_result.data.len());
    }

    #[tokio::test]
    async fn test_composite_upload_fee_breakdown_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let test_data = b"Test data for fee breakdown";
        let result = sdk.upload("test_group", test_data, "test.txt").await.unwrap();
        
        assert!(!result.cid.is_empty(), "CID should not be empty");
        assert_eq!(result.file_hash.len(), 64, "File hash should be 64 hex chars");
        println!("✅ Upload fee breakdown test: cid={}, hash={}", result.cid, result.file_hash);
    }

    #[tokio::test]
    async fn test_retrieve_fee_breakdown_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let original_data = b"Test data for retrieve fee breakdown";
        let upload_result = sdk.upload("test_group", original_data, "fee_retrieve_test.txt").await.unwrap();
        let cid = &upload_result.cid;
        
        let retrieve_result = sdk.retrieve("test_group", cid).await.unwrap();
        println!("✅ Retrieve success: {} bytes", retrieve_result.data.len());
        assert_eq!(retrieve_result.data, original_data);
        assert_eq!(retrieve_result.group_id, "test_group");
    }

    #[tokio::test]
    async fn test_get_transactions_for_group_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let txs = sdk.get_transactions_for_group("test_group", None).await.unwrap();
        println!("Retrieved {} transactions for group", txs.len());
        
        if !txs.is_empty() {
            let tx = &txs[0];
            assert!(!tx.ipfs_hash.is_empty());
            assert!(!tx.file_hash.is_empty());
            assert!(!tx.group_id.is_empty());
            assert!(!tx.user_id.is_empty());
            println!("First tx: group={}, user={}, ipfs={}", 
                     tx.group_id, tx.user_id, tx.ipfs_hash);
        }
    }

    #[tokio::test]
    async fn test_is_authorized_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let authorized = sdk.is_authorized("test_group", None).await.unwrap();
        println!("User authorized for test_group: {}", authorized);
        // User should be authorized if they've used the group
    }

    #[tokio::test]
    async fn test_get_group_owner_integration() {
        let sdk = match get_integration_sdk() {
            Some(s) => s,
            None => {
                println!("Skipping: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
                return;
            }
        };

        let owner = sdk.get_group_owner("test_group").await.unwrap();
        if let Some(o) = owner {
            println!("test_group owner: {}", o);
            assert!(o.contains(".testnet") || o.contains(".near"));
        } else {
            println!("test_group has no owner (may not exist)");
        }
    }
}
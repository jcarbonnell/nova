use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_client::methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest;
use near_jsonrpc_primitives::types::query::QueryResponseKind as JsonRpcQueryResponseKind;
use near_primitives::types::{AccountId, Balance, BlockReference, Finality, BlockHeight};
use near_primitives::views::{QueryRequest, ExecutionOutcomeView, FinalExecutionOutcomeView, ExecutionStatusView};
use near_primitives::hash::CryptoHash;
use near_primitives::transaction::{
    Action, FunctionCallAction, SignedTransaction, TransferAction
};
use near_crypto::{InMemorySigner, Signer, SecretKey};
use thiserror::Error;
use std::str::FromStr;
use serde_json::json;
use base64::Engine;
use base64::engine::general_purpose;
use tokio::time::{sleep, Duration};

#[derive(Error, Debug)]
pub enum NovaError {
    #[error("Near RPC error: {0}")]
    Near(String),
    #[error("Invalid key length or format")]
    InvalidKey,
    #[error("Account ID parse failed")]
    ParseAccount,
    #[error("Signing error: {0}")]
    Signing(String),
}

#[derive(serde::Deserialize, Debug)]
pub struct Transaction {
    pub group_id: String,
    pub user_id: String,
    pub file_hash: String,
    pub ipfs_hash: String,
}

/// Result structs for composites
#[derive(Debug)]
pub struct CompositeUploadResult {
    pub cid: String,
    pub trans_id: String,
    pub file_hash: String,
}

#[derive(Debug)]
pub struct CompositeRetrieveResult {
    pub data: Vec<u8>,
    pub file_hash: String,
}

#[derive(Debug)]
pub struct NovaSdk {
    client: JsonRpcClient,
    contract_id: AccountId,
    signer: Option<Signer>,
    pinata_key: String,
    pinata_secret: String,
}

impl NovaSdk {  // REMOVED generic type parameter
    /// Creates a new NovaSdk instance.
    pub fn new(rpc_url: &str, contract_id: &str, pinata_key: &str, pinata_secret: &str) -> Self {
        let client = JsonRpcClient::connect(rpc_url);
        let contract_id = AccountId::from_str(contract_id).expect("Invalid contract_id format");
        NovaSdk {
            client,
            contract_id,
            signer: None,
            pinata_key: pinata_key.to_string(),
            pinata_secret: pinata_secret.to_string(),
        }
    }

    /// Attaches a signer using a NEAR private key string (e.g., "ed25519:base58key").
    pub fn with_signer(mut self, private_key: &str, account_id: &str) -> Result<Self, NovaError> {
        // Validate account_id first
        let account_id_acc = AccountId::from_str(account_id).map_err(|_| NovaError::ParseAccount)?;
        // Then parse the secret key
        let secret_key = SecretKey::from_str(private_key).map_err(|e| NovaError::Signing(e.to_string()))?;
        let signer = InMemorySigner::from_secret_key(account_id_acc, secret_key);
        self.signer = Some(signer);
        Ok(self)
    }

    /// Queries the balance of an account on NEAR.
    pub async fn get_balance(&self, account_id: &str) -> Result<Balance, NovaError> {
        let account_id_acc = AccountId::from_str(account_id).map_err(|_| NovaError::ParseAccount)?;
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::ViewAccount { account_id: account_id_acc },
        };
        let response = self.client.call(request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        match response.kind {
            JsonRpcQueryResponseKind::ViewAccount(acc) => Ok(acc.amount),
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Checks if a user is authorized in a group (read-only contract view).
    pub async fn is_authorized(&self, group_id: &str, user_id: &str) -> Result<bool, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id.to_string()}).to_string().into_bytes();
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "is_authorized".to_string(),
                args: args.into(),
            },
        };
        let response = self.client.call(request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let bool_result: bool = serde_json::from_slice(&result.result).map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(bool_result)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Fetches the base64-encoded group key for an authorized user (read-only contract view).
    pub async fn get_group_key(&self, group_id: &str, user_id: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id.to_string()}).to_string().into_bytes();
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "get_group_key".to_string(),
                args: args.into(),
            },
        };
        let response = self.client.call(request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let key: String = serde_json::from_slice(&result.result).map_err(|e| NovaError::Near(e.to_string()))?;
                Ok(key)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Fetches transactions for a group (authorized user view).
    pub async fn get_transactions_for_group(&self, group_id: &str, user_id: &str) -> Result<Vec<Transaction>, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id}).to_string().into_bytes();
        let request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::CallFunction {
                account_id: self.contract_id.clone(),
                method_name: "get_transactions_for_group".to_string(),
                args: args.into(),
            },
        };
        let response = self.client.call(request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        match response.kind {
            JsonRpcQueryResponseKind::CallResult(result) => {
                let txs: Vec<Transaction> = serde_json::from_slice(&result.result)
                    .map_err(|e| NovaError::Near(format!("Failed to parse transactions: {}", e)))?;
                Ok(txs)
            }
            _ => Err(NovaError::Near("Invalid response kind".to_string())),
        }
    }

    /// Executes a signed function call on the contract.
    async fn execute_contract_call(
        &self,
        method_name: &str,
        args: Vec<u8>,
        gas: u64,
        attached_deposit: u128,
    ) -> Result<FinalExecutionOutcomeView, NovaError> {
        let signer = self.signer.as_ref().ok_or(NovaError::Signing("No signer attached".to_string()))?;

        let signer_account_id = match signer {
            Signer::InMemory(s) => s.account_id.clone(),
            _ => return Err(NovaError::Signing("Unsupported signer type".to_string())),
        };

        let public_key = match signer {
            Signer::InMemory(s) => s.public_key.clone(),
            _ => return Err(NovaError::Signing("Unsupported signer type".to_string())),
        };

        // Fetch latest access key for nonce
        let access_key_request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::ViewAccessKey {
                account_id: signer_account_id.clone(),
                public_key: public_key.clone(),
            },
        };
        let access_key_response = self.client.call(access_key_request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        let access_key = match access_key_response.kind {
            JsonRpcQueryResponseKind::AccessKey(ak) => ak,
            _ => return Err(NovaError::Near("Invalid access key response".to_string())),
        };
        let nonce = access_key.nonce + 1;

        // Fetch latest block hash
        let block_request = methods::block::RpcBlockRequest {
            block_reference: BlockReference::Finality(Finality::Final),
        };
        let block_response = self.client.call(block_request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        let block_hash: CryptoHash = block_response.header.hash;
        let block_height: BlockHeight = block_response.header.height;

        // Build transaction with FunctionCallAction
        let actions = vec![Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: method_name.to_string(),
            args,
            gas,
            deposit: attached_deposit,
        }))];

        // Use SignedTransaction::from_actions to construct the transaction
        let signed_tx = SignedTransaction::from_actions(
            nonce,
            signer_account_id,
            self.contract_id.clone(),
            signer,
            actions,
            block_hash,
            block_height,
        );

        let broadcast_request = RpcBroadcastTxCommitRequest { signed_transaction: signed_tx };
        let broadcast_response = self.client.call(broadcast_request).await.map_err(|e| NovaError::Near(e.to_string()))?;

        Ok(broadcast_response)
    }

    /// Registers a new group (owner-only, payable).
    pub async fn register_group(&self, group_id: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id}).to_string().into_bytes();
        let outcome = self.execute_contract_call("register_group", args, 300_000_000_000_000, 100_000_000_000_000_000_000_000).await?;
        self.parse_outcome(&outcome.transaction_outcome.outcome)
    }

    /// Adds a member to a group (owner-only, payable).
    pub async fn add_group_member(&self, group_id: &str, user_id: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id}).to_string().into_bytes();
        let outcome = self.execute_contract_call("add_group_member", args, 300_000_000_000_000, 500_000_000_000_000_000).await?;
        self.parse_outcome(&outcome.transaction_outcome.outcome)
    }

    /// Revokes a member from a group (owner-only, payable, rotates key).
    pub async fn revoke_group_member(&self, group_id: &str, user_id: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id}).to_string().into_bytes();
        let outcome = self.execute_contract_call("revoke_group_member", args, 300_000_000_000_000, 500_000_000_000_000_000).await?;
        self.parse_outcome(&outcome.transaction_outcome.outcome)
    }

    /// Stores a base64 group key (owner-only, payable).
    pub async fn store_group_key(&self, group_id: &str, key_b64: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id, "key": key_b64}).to_string().into_bytes();
        let outcome = self.execute_contract_call("store_group_key", args, 300_000_000_000_000, 500_000_000_000_000_000).await?;
        self.parse_outcome(&outcome.transaction_outcome.outcome)
    }

    /// Records a file transaction (owner-only, payable, returns trans_id).
    pub async fn record_transaction(&self, group_id: &str, user_id: &str, file_hash: &str, ipfs_hash: &str) -> Result<String, NovaError> {
        let args = json!({"group_id": group_id, "user_id": user_id, "file_hash": file_hash, "ipfs_hash": ipfs_hash}).to_string().into_bytes();
        let outcome = self.execute_contract_call("record_transaction", args, 300_000_000_000_000, 2_000_000_000_000_000_000).await?;
        match self.parse_outcome_detailed(&outcome.transaction_outcome.outcome) {
            Ok(value) => Ok(value),
            Err(_) => self.parse_outcome(&outcome.transaction_outcome.outcome),
        }
    }

    /// Transfers tokens to another account (signed transfer action).
    pub async fn transfer_tokens(&self, to_account: &str, amount_yocto: u128) -> Result<String, NovaError> {
        let to_id = AccountId::from_str(to_account).map_err(|_| NovaError::ParseAccount)?;
        let actions = vec![Action::Transfer(TransferAction { deposit: amount_yocto })];
        let outcome = self.execute_transfer(to_id, actions).await?;
        self.parse_outcome(&outcome.transaction_outcome.outcome)
    }

    async fn execute_transfer(
        &self,
        to_id: AccountId,
        actions: Vec<Action>,
    ) -> Result<FinalExecutionOutcomeView, NovaError> {
        let signer = self.signer.as_ref().ok_or(NovaError::Signing("No signer attached".to_string()))?;

        let signer_account_id = match signer {
            Signer::InMemory(s) => s.account_id.clone(),
            _ => return Err(NovaError::Signing("Unsupported signer type".to_string())),
        };

        let public_key = match signer {
            Signer::InMemory(s) => s.public_key.clone(),
            _ => return Err(NovaError::Signing("Unsupported signer type".to_string())),
        };

        // Fetch nonce and block hash
        let access_key_request = methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::ViewAccessKey {
                account_id: signer_account_id.clone(),
                public_key: public_key.clone(),
            },
        };
        let access_key_response = self.client.call(access_key_request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        let access_key = match access_key_response.kind {
            JsonRpcQueryResponseKind::AccessKey(ak) => ak,
            _ => return Err(NovaError::Near("Invalid access key response".to_string())),
        };
        let nonce = access_key.nonce + 1;

        let block_request = methods::block::RpcBlockRequest {
            block_reference: BlockReference::Finality(Finality::Final),
        };
        let block_response = self.client.call(block_request).await.map_err(|e| NovaError::Near(e.to_string()))?;
        let block_hash: CryptoHash = block_response.header.hash;
        let block_height: BlockHeight = block_response.header.height;

        let signed_tx = SignedTransaction::from_actions(
            nonce,
            signer_account_id,
            to_id,
            signer,
            actions,
            block_hash,
            block_height,
        );

        let broadcast_request = RpcBroadcastTxCommitRequest { signed_transaction: signed_tx };
        let broadcast_response = self.client.call(broadcast_request).await.map_err(|e| NovaError::Near(e.to_string()))?;

        Ok(broadcast_response)
    }

    fn parse_outcome(&self, outcome: &ExecutionOutcomeView) -> Result<String, NovaError> {
        match &outcome.status {
            ExecutionStatusView::SuccessValue(value) => {
                if !value.is_empty() {
                    String::from_utf8(value.clone()).map_err(|e| NovaError::Near(e.to_string()))
                } else {
                    Ok("Success".to_string())
                }
            }
            ExecutionStatusView::SuccessReceiptId(_) => Ok("Success".to_string()),
            _ => Err(NovaError::Near("Transaction failed".to_string())),
        }
    }

    fn parse_outcome_detailed(&self, outcome: &ExecutionOutcomeView) -> Result<String, NovaError> {
        match &outcome.status {
            ExecutionStatusView::SuccessValue(value) => String::from_utf8(value.clone()).map_err(|e| NovaError::Near(e.to_string())),
            _ => Err(NovaError::Near("Transaction failed - no return value".to_string())),
        }
    }

    /// Full upload workflow: get_key → encrypt → IPFS pin → record tx.
    pub async fn composite_upload(
        &self,
        group_id: &str,
        user_id: &str,
        data: &[u8],
        filename: &str,
    ) -> Result<CompositeUploadResult, NovaError> {
        // Step 1: Fetch group key
        let key_b64 = self.get_group_key(group_id, user_id).await?;
        
        // Step 2: Encrypt data
        let encrypted_b64 = self.encrypt_data(data, &key_b64)?;
        
        // Step 3: Upload to IPFS
        let cid = self.ipfs_upload(&encrypted_b64, filename).await?;
        
        // Step 4: Calculate file hash from original data
        let file_hash = hex_encode(&sha256_hash(data));
        
        // Step 5: Record transaction on blockchain
        let trans_id = self.record_transaction(group_id, user_id, &file_hash, &cid).await?;
        
        Ok(CompositeUploadResult {
            cid,
            trans_id,
            file_hash,
        })
    }

    /// Full retrieve workflow: get_key → fetch IPFS → decrypt.
    pub async fn composite_retrieve(
        &self,
        group_id: &str,
        ipfs_hash: &str,
    ) -> Result<CompositeRetrieveResult, NovaError> {
        // Validate CID format
        if !ipfs_hash.starts_with("Qm") {
            return Err(NovaError::Near(format!("Invalid CID: {}", ipfs_hash)));
        }
        
        // Step 1: Get user_id from signer
        let user_id = match &self.signer {
            Some(Signer::InMemory(s)) => s.account_id.to_string(),
            None => return Err(NovaError::Signing("No signer attached for retrieve".to_string())),
            _ => return Err(NovaError::Signing("Unsupported signer type".to_string())),
        };
        
        // Step 2: Fetch group key
        let key_b64 = self.get_group_key(group_id, &user_id).await?;
        
        // Step 3: Fetch from IPFS
        let encrypted_b64 = self.ipfs_retrieve(ipfs_hash).await?;
        
        // Step 4: Decrypt
        let decrypted_b64 = self.decrypt_data(&encrypted_b64, &key_b64)?;
        
        // Step 5: Calculate hash for verification
        let decrypted_bytes = general_purpose::STANDARD.decode(&decrypted_b64)
            .map_err(|_| NovaError::InvalidKey)?;
        let file_hash = hex_encode(&sha256_hash(&decrypted_bytes));
        
        Ok(CompositeRetrieveResult {
            data: decrypted_bytes,
            file_hash,
        })
    }

    /// Helper: Encrypt data with AES-256-CBC
    fn encrypt_data(&self, data: &[u8], key_b64: &str) -> Result<String, NovaError> {
        use aes::Aes256;
        use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        
        type Aes256CbcEnc = cbc::Encryptor<Aes256>;
        
        // Decode key
        let key_bytes = general_purpose::STANDARD.decode(key_b64)
            .map_err(|_| NovaError::InvalidKey)?;
        if key_bytes.len() != 32 {
            return Err(NovaError::InvalidKey);
        }
        
        // Generate random IV (16 bytes)
        let mut iv = [0u8; 16];
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut iv);
        
        // Prepare buffer with room for padding
        let mut buffer = vec![0u8; data.len() + 16];
        buffer[..data.len()].copy_from_slice(data);

        // Encrypt with padding
        let cipher = Aes256CbcEnc::new(key_bytes.as_slice().into(), &iv.into());
        let ciphertext = cipher.encrypt_padded_mut::<Pkcs7>(&mut buffer, data.len())
            .map_err(|_| NovaError::Near("Encryption failed".to_string()))?;
        
        // Prepend IV to ciphertext
        let mut result = iv.to_vec();
        result.extend_from_slice(ciphertext);
        
        Ok(general_purpose::STANDARD.encode(result))
    }

    /// Helper: Decrypt data with AES-256-CBC
    fn decrypt_data(&self, encrypted_b64: &str, key_b64: &str) -> Result<String, NovaError> {
        use aes::Aes256;
        use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
        
        type Aes256CbcDec = cbc::Decryptor<Aes256>;
        
        // Decode key and encrypted data
        let key_bytes = general_purpose::STANDARD.decode(key_b64)
            .map_err(|_| NovaError::InvalidKey)?;
        if key_bytes.len() != 32 {
            return Err(NovaError::InvalidKey);
        }
        
        let encrypted_bytes = general_purpose::STANDARD.decode(encrypted_b64)
            .map_err(|_| NovaError::InvalidKey)?;
        if encrypted_bytes.len() < 16 {
            return Err(NovaError::InvalidKey);
        }
        
        // Extract IV (first 16 bytes) and ciphertext
        let (iv, ciphertext) = encrypted_bytes.split_at(16);
        
        // Decrypt with padding removal
        let cipher = Aes256CbcDec::new(key_bytes.as_slice().into(), iv.into());
        let mut buffer = ciphertext.to_vec();
        let decrypted = cipher.decrypt_padded_mut::<Pkcs7>(&mut buffer)
            .map_err(|_| NovaError::Near("Decryption failed".to_string()))?;
        
        Ok(general_purpose::STANDARD.encode(decrypted))
    }

    /// Helper: Upload to IPFS via Pinata
    async fn ipfs_upload(&self, data_b64: &str, filename: &str) -> Result<String, NovaError> {
        use reqwest::multipart;
        
        let client = reqwest::Client::new();
        let decoded_data = general_purpose::STANDARD.decode(data_b64)
            .map_err(|_| NovaError::InvalidKey)?;
        
        let part = multipart::Part::bytes(decoded_data)
            .file_name(filename.to_string());
        let form = multipart::Form::new().part("file", part);
        
        let response = client
            .post("https://api.pinata.cloud/pinning/pinFileToIPFS")
            .header("pinata_api_key", &self.pinata_key)
            .header("pinata_secret_api_key", &self.pinata_secret)
            .multipart(form)
            .send()
            .await
            .map_err(|e| NovaError::Near(format!("IPFS upload failed: {}", e)))?;
        
        let json: serde_json::Value = response.json().await
            .map_err(|e| NovaError::Near(format!("IPFS response parse failed: {}", e)))?;
        
        json["IpfsHash"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or(NovaError::Near("No IpfsHash in response".to_string()))
    }

    /// Helper: Retrieve from IPFS via Pinata gateway
    async fn _inner_retrieve(&self, cid: &str, client: &reqwest::Client) -> Result<String, NovaError> {
        let url = format!("https://gateway.pinata.cloud/ipfs/{}", cid);
        let response = client.get(&url)
            .send()
            .await
            .map_err(|e| NovaError::Near(format!("IPFS retrieve failed: {}", e)))?;
        let bytes = response.bytes().await
            .map_err(|e| NovaError::Near(format!("IPFS read failed: {}", e)))?;
        Ok(general_purpose::STANDARD.encode(bytes))
    }

    async fn ipfs_retrieve(&self, cid: &str) -> Result<String, NovaError> {
        let client = reqwest::Client::new();
        let mut retries = 0;
        while retries < 3 {
            match self._inner_retrieve(cid, &client).await {
                Ok(res) => return Ok(res),
                Err(e) if e.to_string().contains("timeout") => {
                    retries += 1;
                    sleep(Duration::from_secs(2u64.pow((retries as u64).try_into().unwrap()))).await;
                }
                Err(e) => return Err(e),
            }
        }
    
        // Fallback to public gateway after retries
        let public_url = format!("https://ipfs.io/ipfs/{}", cid);
        let response = client.get(&public_url)
            .send()
            .await
            .map_err(|e| NovaError::Near(format!("Public IPFS fallback failed: {}", e)))?;
        let bytes = response.bytes().await
            .map_err(|e| NovaError::Near(format!("Public IPFS read failed: {}", e)))?;
        Ok(general_purpose::STANDARD.encode(bytes))
    }
}

/// Helper function for SHA-256 hashing
fn sha256_hash(data: &[u8]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// Helper function to convert byte array to hex string
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngCore;

    #[tokio::test]
    async fn test_new() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        assert_eq!(sdk.contract_id.as_str(), "nova-sdk-2.testnet");
        assert!(sdk.signer.is_none());
    }

    #[tokio::test]
    async fn test_with_signer_valid_format() {
        // Dummy valid-format key (expects Signing err on invalid base58, but tests parse call)
        let private_key = "ed25519:ABC123dummybase58key32bytesencodedhereforrusttest";
        let account_id = "test.account.testnet";
        let result = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(private_key, account_id);
        // Expects Signing error (invalid base58), but no panic/crash
        assert!(matches!(result.err().unwrap(), NovaError::Signing(_)));
    }

    #[tokio::test]
    async fn test_with_signer_invalid_account() {
        let private_key = "ed25519:dummy";
        let invalid_account = "invalid@account";
        let result = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(private_key, invalid_account);
        assert!(matches!(result.err().unwrap(), NovaError::ParseAccount));
    }

    #[tokio::test]
    async fn test_get_balance() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let balance = sdk.get_balance("nova-sdk-2.testnet").await.unwrap();
        let bal_str = balance.to_string();
        assert!(!bal_str.is_empty()); // Valid yoctoNEAR like "123..."
        assert!(bal_str.parse::<u128>().is_ok()); // Ensures it's a number string
    }

    #[tokio::test]
    async fn test_is_authorized() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        // Test with a likely non-member user and existing group (from contract)
        let authorized = sdk.is_authorized("test_group", "random.user.testnet").await.unwrap();
        assert!(!authorized, "Random user should not be authorized");
    }

    #[tokio::test]
    async fn test_get_group_key_unauthorized() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        // Expect error (Unauthorized panic in contract → RPC error)
        let result = sdk.get_group_key("test_group", "random.user.testnet").await;
        assert!(result.is_err(), "Unauthorized user should fail to get key");
        assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }

    #[tokio::test]
    async fn test_get_group_key_authorized() {
        // Skip unless TEST_NEAR_ACCOUNT_ID set (like integration.rs)
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if account_id.is_none() {
            return;
        }
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let key = sdk.get_group_key("test_group", &account_id.unwrap()).await.unwrap();
        assert!(!key.is_empty(), "Key should be non-empty base64");
        assert!(key.len() > 20, "Base64 key should be reasonable length");
    }

    #[tokio::test]
    async fn test_get_transactions_for_group() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        // Test with likely empty/unauth → expect empty vec or err
        let result = sdk.get_transactions_for_group("test_group", "random.user.testnet").await;
        match result {
            Ok(txs) => assert!(txs.is_empty(), "Unauthorized should return empty vec"),
            Err(e) => assert!(matches!(e, NovaError::Near(_)), "Expect Near err for auth fail"),
        }
    }

    // Integration (env-guarded)
    #[tokio::test]
    async fn test_get_transactions_for_group_integration() {
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if account_id.is_none() {
            println!("Skipping: TEST_NEAR_ACCOUNT_ID not set");
            return;
        }
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let txs = sdk.get_transactions_for_group("test_group", &account_id.unwrap()).await.unwrap();
        // If group has txs, expect non-empty; else empty is fine
        println!("Retrieved {} transactions for group", txs.len());
        if !txs.is_empty() {
            assert!(!txs[0].ipfs_hash.is_empty(), "First tx should have valid IPFS hash");
        }
    }

    #[tokio::test]
    async fn test_view_invalid_group() {
    let sdk = NovaSdk::new(
        "https://rpc.testnet.near.org",
        "nova-sdk-2.testnet",
        "fake_key",
        "fake_secret",
    );
    // Non-existent group should cause contract panic → RPC error
    let result = sdk.is_authorized("nonexistent_group_123", "test.user.testnet").await;
    assert!(result.is_err(), "Invalid group should fail with error");
    assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }

    #[tokio::test]
    #[should_panic(expected = "No signer attached")]
    async fn test_register_group_no_signer() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let _ = sdk.register_group("new_test_group").await.unwrap();
    }

    #[tokio::test]
    async fn test_register_group_existing() {
        // Use env for signer; skip if not set
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping test_register_group_existing: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        // Try to register existing group → expect failure (contract assert)
        let result = sdk.register_group("test_group").await;
        assert!(result.is_err(), "Registering existing group should fail");
        assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }

    #[tokio::test]
    async fn test_add_group_member() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping test_add_group_member: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        let result = sdk.add_group_member("test_group", "new.member.testnet").await;
        match result {
            Ok(_) => println!("✅ Added member successfully"),
            Err(e) => if e.to_string().contains("already a member") { println!("Already member - expected") } else { panic!("Unexpected error: {}", e) },
        }
    }

    #[tokio::test]
    #[should_panic(expected = "No signer attached")]
    async fn test_revoke_group_member_no_signer() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let _ = sdk.revoke_group_member("test_group", "test.user.testnet").await.unwrap();
    }

    #[tokio::test]
    async fn test_revoke_group_member_invalid_user() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping test_revoke_group_member_invalid_user: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        // Revoke non-member → expect contract error (user not found)
        let result = sdk.revoke_group_member("test_group", "non.member.testnet").await;
        assert!(result.is_err(), "Revoking non-member should fail");
        assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }

    #[tokio::test]
    #[should_panic(expected = "No signer attached")]
    async fn test_store_group_key_no_signer() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let _ = sdk.store_group_key("test_group", "dummyb64key").await.unwrap();
    }

    #[tokio::test]
    async fn test_store_group_key_invalid_key() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping test_store_group_key_invalid_key: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        // Invalid base64 key → expect contract panic on decode/len
        let invalid_key = "invalid_not_base64";
        let result = sdk.store_group_key("test_group", invalid_key).await;
        assert!(result.is_err(), "Invalid key should fail");
        assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }

    #[tokio::test]
    #[should_panic(expected = "No signer attached")]
    async fn test_record_transaction_no_signer() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let _ = sdk.record_transaction("test_group", "user.testnet", "dummy_hash", "QmDummyCID").await.unwrap();
    }

    #[tokio::test]
    async fn test_record_transaction_unauthorized_user() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping test_record_transaction_unauthorized_user: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        // Record for unauthorized user → expect contract error
        let result = sdk.record_transaction("test_group", "unauth.user.testnet", "dummy_hash", "QmDummyCID").await;
        assert!(result.is_err(), "Unauthorized user should fail");
        assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
    }


    #[tokio::test]
    #[should_panic(expected = "No signer attached")]
    async fn test_transfer_tokens_no_signer() {
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            "fake_key",
            "fake_secret",
        );
        let _ = sdk.transfer_tokens("receiver.testnet", 1_000_000_000_000_000_000).await.unwrap(); // 1 NEAR
    }

    #[tokio::test]
    async fn test_transfer_tokens_invalid_to() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping: Credentials not set");
            return;
        }
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake")
            .with_signer(&private_key.unwrap(), &account_id.unwrap()).unwrap();
        let result = sdk.transfer_tokens("invalid@to", 1);
        assert!(matches!(result.await.err().unwrap(), NovaError::ParseAccount));
    }

    #[tokio::test]
    async fn test_encrypt_decrypt_binary() {
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake");
    
        // Generate test key
        let mut key_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key_bytes);
        let key_b64 = general_purpose::STANDARD.encode(key_bytes);
    
        // Test with binary data (not valid UTF-8)
        let original_data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]; // JPEG header
        let encrypted = sdk.encrypt_data(&original_data, &key_b64).unwrap();
        let decrypted_b64 = sdk.decrypt_data(&encrypted, &key_b64).unwrap();
        let decrypted_bytes = general_purpose::STANDARD.decode(decrypted_b64).unwrap();
    
        assert_eq!(original_data, decrypted_bytes);
    }

    #[tokio::test]
    async fn test_composite_upload_binary_integration() {
        let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
        let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
        if private_key.is_none() || account_id.is_none() {
            println!("Skipping: Credentials not set");
            return;
        }
        
        let pinata_key = std::env::var("PINATA_API_KEY").unwrap();
        let pinata_secret = std::env::var("PINATA_SECRET_KEY").unwrap();
        
        let sdk = NovaSdk::new(
            "https://rpc.testnet.near.org",
            "nova-sdk-2.testnet",
            &pinata_key,
            &pinata_secret
        ).with_signer(&private_key.unwrap(), &account_id.clone().unwrap()).unwrap();
        
        // Test with binary image data (PNG header)
        let binary_data = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A  // PNG magic bytes
        ];
        
        let result = sdk.composite_upload(
            "test_group",
            &account_id.unwrap(),
            &binary_data,
            "test.png"
        ).await.unwrap();
        
        println!("✅ Binary upload success: {}", result.cid);
        assert!(!result.cid.is_empty());
    }

    #[tokio::test]
    async fn test_composite_upload_no_signer() {
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake");
        let test_data = b"test data";
        let result = sdk.composite_upload("test_group", "user.testnet", test_data, "test.txt").await;
        // Should fail at get_group_key or record_transaction (no signer)
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_composite_retrieve_no_signer() {
        let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake", "fake");
        let result = sdk.composite_retrieve("test_group", "QmDummyCID").await;
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), NovaError::Signing(_)));
    }
}
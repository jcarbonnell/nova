# NOVA SDK for Rust

**Version:** 1.1.1
**License:** MIT  
**Network:** NEAR Protocol Mainnet
**Crates:** [nova-sdk-rs](https://crates.io/crates/nova-sdk-rs)

A Rust SDK for NOVA's secure, decentralized file-sharing primitive on NEAR. NOVA hybridizes on-chain access control with off-chain TEE-secured keys via Shade Agents, using nonce-based ed25519-signed tokens for ephemeral, verifiable access. This ensures privacy-first data sharing for AI datasets, healthcare/financial records, and sensitive documents.

## Features

- 🔐 **Zero-Knowledge Architecture** - Keys managed in TEE; never exposed to SDK
- 🌐 **FastFS Storage** - File data on NEAR via FastFS (FastNear); legacy IPFS reads preserved
- ⛓️ **NEAR Blockchain** - Immutable access control & transaction logs
- 🛡️ **API Key Auth** - Secure authentication via API keys (get yours at nova-sdk.com)
- 🔑 **Automated Signing** - MCP server signs transactions using keys from Shade TEE
- 👥 **Group Management** - Fine-grained membership with automatic key rotation on revocation
- 🔑 **Per-File Keys** - Each file encrypted with its own key; deletion crypto-shreds it (permanently undecryptable)
- ⏳ **Retention** - Optional per-group retention windows for time-based deletion
- 🚀 **Composite Operations** - Simplified workflows for upload/retrieve

## Installation

Add to `Cargo.toml`:

```toml
[dependencies]
nova-sdk-rs = "1.1.1"
tokio = { version = "1", features = ["full"] }
chrono = "0.4"
```

## ⚠️ Mainnet Notice

**NOVA v1.0.0 operates on NEAR mainnet by default.** All operations consume real NEAR tokens.

**Typical costs:**
- Register group: ~0.05 NEAR (~$0.15 USD)
- Upload file: ~0.01 NEAR + IPFS storage
- Retrieve file: ~0.001 NEAR

For development, use testnet configuration:
```rust
let config = NovaSdkConfig::testnet()
    .with_api_key(&std::env::var("NOVA_API_KEY")?);
let sdk = NovaSdk::with_config("alice.nova-sdk-6.testnet", config)?;
```

> **Note:** On testnet, IPFS operations are mocked (in-memory storage). Blockchain operations use real testnet with faucet tokens.

## Quick Start

### 1. Prerequisites

1. **Create a NOVA account** at [nova-sdk.com](https://nova-sdk.com)
2. **Generate an API key** from the "Manage Account" menu
3. **Fund your account** with NEAR tokens for transaction fees

### 2. Basic Usage
```rust
use nova_sdk_rs::{NovaSdk, NovaSdkConfig};
use std::fs;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize SDK with API key
    let config = NovaSdkConfig::default()
        .with_api_key(&std::env::var("NOVA_API_KEY")?);
    let sdk = NovaSdk::with_config("alice.nova-sdk.near", config)?;

    // For testnet development:
    // let sdk = NovaSdk::testnet("alice.nova-sdk-6.testnet")?;

    // Verify connection
    println!("Network: {} | Contract: {}", sdk.network_id(), sdk.contract_id());

    // Register group
    sdk.register_group("my-secure-files").await?;

    // Upload file (client-side encryption)
    let file_data = fs::read("./confidential.pdf")?;
    let result = sdk.upload(
        "my-secure-files",
        &file_data,
        "confidential.pdf"
    ).await?;

    println!("✅ Uploaded: {}", result.cid);
    println!("📝 Transaction: {}", result.trans_id);

    // Retrieve file (client-side decryption)
    let retrieved = sdk.retrieve(
        "my-secure-files",
        &result.cid
    ).await?;

    fs::write("./decrypted.pdf", &retrieved.data)?;
    println!("✅ Decrypted!");

    Ok(())
}
```

## Core Concepts

### Groups

Groups manage shared access to encrypted files. Each group has:
- A unique identifier (`group_id`)
- An owner who manages membership
- A shared encryption key stored off-chain in Shade Agent/TEE (never stored publicly).
- A list of authorized members

### Access Control (Ephemeral Tokens)

NOVA uses signed tokens for key access:
- Generate payload (group_id/user_id/nonce/timestamp/signing_pk_b58).
- Sign with ed25519 (from account keypair).
- Claim on-chain (claim_token): Verifies sig/membership/nonce (5min window), returns token.
- Present to Shade: TEE decrypts key, verifies checksum, responds transiently.

### Encryption

All data is encrypted **client-side** using AES-256-GCM:
- 256-bit symmetric keys (retrieved from Shade TEE)
- 12-byte random IV per encryption
- Authenticated encryption with integrity verification
- SHA256 hashing for file integrity
- **Keys never leave the client unencrypted**

### Transaction Recording

File metadata (location/hash) is recorded on-chain automatically during upload.

```rust
// Query group transactions
let txs = sdk.get_transactions_for_group("my_group", None).await?;
for tx in txs {
    println!("File: {} | Location: {}", tx.file_hash, tx.ipfs_hash);
}
```

### Authentication

The SDK uses API keys for secure authentication. Get your key at [nova-sdk.com](https://nova-sdk.com):

1. Create or log into your NOVA account
2. Click "Manage Account"  
3. Click "Show My API Key" (reveals your current key; or "Rotate" to issue a fresh one)
4. Copy the key (shown only once!)
```bash
# Store in .env (never commit to git!)
NOVA_ACCOUNT_ID=alice.nova-sdk.near
NOVA_API_KEY=nova_sk_xxxxxxxxxxxxxxxxxxxxx
```
```rust
use nova_sdk_rs::{NovaSdk, NovaSdkConfig};

// Initialize with API key
let config = NovaSdkConfig::default()
    .with_api_key(&std::env::var("NOVA_API_KEY")?);
let sdk = NovaSdk::with_config("alice.nova-sdk.near", config)?;

// Force refresh session token if needed
sdk.refresh_token().await?;
```

**Note:** One API key per account. Viewing/generating returns your current key; use **Rotate** at nova-sdk.com to issue a fresh key and permanently invalidate the old one.

### How Authentication Works

The SDK uses a two-step authentication flow:
1. API key → Session token (JWT with 24h expiry)
2. Session token → MCP operations

Session tokens are automatically managed by the SDK and refreshed before expiration. You can force a refresh with:
```rust
sdk.refresh_token().await?;
```

Session tokens contain your `account_id` and are validated by the MCP server at port 8000.

## API Reference

### Initialization

```rust
use nova_sdk_rs::{NovaSdk, NovaSdkConfig};

// Standard usage (mainnet) - API key required
let config = NovaSdkConfig::default()
    .with_api_key(&std::env::var("NOVA_API_KEY")?);
let sdk = NovaSdk::with_config("alice.nova-sdk.near", config)?;

// Testnet
let config = NovaSdkConfig::testnet()
    .with_api_key(&std::env::var("NOVA_API_KEY")?);
let sdk = NovaSdk::with_config("alice.nova-sdk-6.testnet", config)?;

// Force session token refresh if needed
sdk.refresh_token().await?;
```

### Group Management

```rust
// Check authorization
sdk.auth_status(Some("my-group")).await?;

// Register group
sdk.register_group("my-group").await?;

// Add member
sdk.add_group_member("my-group", "bob.near").await?;

// Revoke member
sdk.revoke_group_member("my-group", "bob.near").await?;

// Self-join an OPEN group (hackathon submission groups the organizer has opened).
// Idempotent: safe to call again if already a member.
sdk.join_group("hackathon-group-id").await?;
```

### File Operations

```rust
// Upload (encrypts locally, uploads to IPFS, records on NEAR)
let result = sdk.upload(group_id, &data, filename).await?;
// Returns: UploadResult { cid, trans_id, file_hash }

// Retrieve (fetches from IPFS, decrypts locally)
let retrieved = sdk.retrieve(group_id, ipfs_hash).await?;
// Returns: RetrieveResult { data, ipfs_hash, group_id }
```

**Deprecated methods** (still work, but emit warnings):
```rust
// Use upload() instead
sdk.composite_upload(group_id, &data, filename).await?;

// Use retrieve() instead  
sdk.composite_retrieve(group_id, ipfs_hash).await?;
```

## Error Handling

The SDK uses a custom `NovaError` enum:

```rust
use nova_sdk_rs::NovaError;

match sdk.upload("my_group", b"data", "file.txt").await {
    Ok(result) => println!("CID: {}", result.cid),
    Err(NovaError::Auth(msg)) if msg.contains("Audience") => {
        eprintln!("Token validation failed - refreshing...");
        sdk.refresh_token().await?;
    },
    Err(NovaError::Near(msg)) => eprintln!("RPC error: {}", msg),
    Err(NovaError::Mcp(msg)) => eprintln!("MCP server error: {}", msg),
    Err(NovaError::Auth(msg)) => eprintln!("Authentication error: {}", msg),
    Err(NovaError::Token(msg)) => eprintln!("Token error: {}", msg),
    Err(NovaError::InvalidCid(cid)) => eprintln!("Invalid CID: {}", cid),
    Err(NovaError::ParseAccount) => eprintln!("Invalid account ID"),
    Err(NovaError::Http(msg)) => eprintln!("HTTP error: {}", msg),
    Err(NovaError::Encryption(msg)) => eprintln!("Encryption error: {}", msg),
    Err(NovaError::Decryption(msg)) => eprintln!("Decryption error: {}", msg),
```

## 🔐 Security Considerations

1. **Never commit API keys** - Use environment variables
2. **Verify network** - Check `sdk.network_id()` before operations
3. **Validate file hashes** - Compare after retrieval
4. **Use TLS** - Always connect over secure connections
5. **Rotate API keys** - If compromised, rotate your key at nova-sdk.com (invalidates the old one)
6. **Client-side encryption** - Keys are fetched from TEE and used locally; encrypted data travels separately from keys

## Examples

See the [examples](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-rs/examples) directory for complete working examples:

- `simple_upload.rs` - Basic file upload
- `group_management.rs` - Managing groups and members

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`cargo test`)
5. Submit a pull request

## License

MIT [LICENSE](LICENSE) - Copyright (c) 2026 CivicTech OÜ

## Resources

- [NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)
- [NEAR Protocol](https://near.org)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)
- [FastFS](https://fastfs.io)
- [Shade Agent](https://docs.near.org/ai/introduction)
- [Phala TEEs](https://phala.com/)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
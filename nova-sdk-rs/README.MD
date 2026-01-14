# NOVA SDK for Rust

**Version:** 1.0.0 (Mainnet)  
**License:** MIT  
**Network:** NEAR Protocol Mainnet
**Crates:** [nova-sdk-rs](https://crates.io/crates/nova-sdk-rs)

A Rust SDK for NOVA's secure, decentralized file-sharing primitive on NEAR. NOVA hybridizes on-chain access control with off-chain TEE-secured keys via Shade Agents, using nonce-based ed25519-signed tokens for ephemeral, verifiable access. This ensures privacy-first data sharing for AI datasets, healthcare/financial records, and sensitive documents.

## Features

- 🔐 **Zero-Knowledge Architecture** - Keys managed in TEE; never exposed to SDK
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable access control & transaction logs
- 🛡️ **Session-Based Auth** - OAuth flow (no private key handling)
- 🔑 **Automated Signing** - MCP server signs transactions using keys from Shade TEE
- 👥 **Group Management** - Fine-grained membership with automatic key rotation on revocation
- 🚀 **Composite Operations** - Simplified workflows for upload/retrieve

## Installation

Add to `Cargo.toml`:

```toml
[dependencies]
nova-sdk-rs = "1.0.0"
tokio = { version = "1", features = ["full"] }
```

## ⚠️ Mainnet Notice

**NOVA v1.0.0 operates on NEAR mainnet by default.** All operations consume real NEAR tokens.

**Typical costs:**
- Register group: ~0.05 NEAR (~$0.15 USD)
- Upload file: ~0.01 NEAR + IPFS storage
- Retrieve file: ~0.001 NEAR

For development, use [testnet configuration](#-testnet-usage).

## Quick Start

### 1. Get Credentials

Visit **[nova-sdk.com](https://nova-sdk.com)** to:
1. Create your NEAR account (e.g., `alice.nova-sdk.near`)
2. Get session token at `/api/auth/session-token`

### 2. Basic Usage
```rust
use nova_sdk_rs::{NovaSdk, NovaSdkConfig};
use std::fs;

#[tokio::main]
async fn main() -> Result> {
    // Initialize SDK (mainnet by default)
    let sdk = NovaSdk::new(
        "alice.nova-sdk.near",
        &std::env::var("NOVA_SESSION_TOKEN")?
    )?;

    // Verify network
    let (network, contract, _) = sdk.get_network_info();
    println!("Network: {} | Contract: {}", network, contract);

    // Register group
    sdk.register_group("my-secure-files").await?;

    // Upload file
    let file_data = fs::read("./confidential.pdf")?;
    let result = sdk.composite_upload(
        "my-secure-files",
        &file_data,
        "confidential.pdf"
    ).await?;

    println!("✅ Uploaded: {}", result.cid);
    println!("💰 Cost: {:?}", result.fee_breakdown);

    // Retrieve file
    let retrieved = sdk.composite_retrieve(
        "my-secure-files",
        &result.cid
    ).await?;

    fs::write("./decrypted.pdf", retrieved.data)?;
    println!("✅ Decrypted! Hash: {}", retrieved.file_hash);

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

All data is encrypted client-side using AES-256-CBC:
- 256-bit symmetric keys
- Random IV per encryption
- PKCS7 padding
- SHA256 hashing for integrity

### Transaction Recording

File metadata (CID/hash) is recorded on-chain automatically during composite_upload.

```rust
// Query group transactions
let txs = sdk.get_transactions_for_group("my_group", None).await?;
for tx in txs {
    println!("File: {} | IPFS: {}", tx.file_hash, tx.ipfs_hash);
}
```

## API Reference

### Initialization

```rust
// Default (mainnet)
let sdk = NovaSdk::new(account_id, session_token)?;

// Custom config
let sdk = NovaSdk::with_config(account_id, session_token, config)?;
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
```

### File Operations

```rust
// Upload
let result = sdk.composite_upload(group_id, &data, filename).await?;

// Retrieve
let retrieved = sdk.composite_retrieve(group_id, ipfs_hash).await?;
```

## Error Handling

The SDK uses a custom `NovaError` enum:

```rust
use nova_sdk_rs::NovaError;

match sdk.composite_upload("my_group", b"data", "file.txt").await {
    Ok(result) => println!("CID: {}", result.cid),
    Err(NovaError::Near(msg)) => eprintln!("RPC error: {}", msg),
    Err(NovaError::Mcp(msg)) => eprintln!("MCP server error: {}", msg),
    Err(NovaError::Auth(msg)) => eprintln!("Authentication error: {}", msg),
    Err(NovaError::InvalidCid(cid)) => eprintln!("Invalid CID: {}", cid),
    Err(NovaError::ParseAccount) => eprintln!("Invalid account ID"),
    Err(NovaError::Http(msg)) => eprintln!("HTTP error: {}", msg),
}
```

## 🔐 Security Considerations

1. **Never commit session tokens** - Use environment variables
2. **Verify network** - Check `sdk.network_id()` before operations
3. **Validate file hashes** - Compare after retrieval
4. **Use TLS** - Always connect over secure connections
5. **Rotate tokens** - Refresh JWT tokens regularly

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
- [Shade Agent](https://docs.near.org/ai/introduction)
- [Phala TEEs](https://phala.com/)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
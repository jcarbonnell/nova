# NOVA SDK for Rust

A Rust SDK for interacting with NOVA secure file-sharing on NEAR blockchain. NOVA hybridizes IPFS storage with Shade Agents and TEEs (via Phala) for verifiable privacy, using ephemeral nonce-based tokens for key access. Files are encrypted client-side and stored off-chain, with on-chain metadata ensuring auditable, group-based controls. In the current SDK, users authenticate with JWT session tokens obtained from nova-sdk.com.

## Features

- 🔐 **AES-256-CBC Encryption** - Client-side encryption for data privacy
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and access control
- 🛡️ **TEE-Verified Keys** - Off-chain keys stored encrypted in Shade Agents (Phala TEEs); no on-chain exposure
- 🔑 **Ephemeral Token Auth** - Ed25519-signed payloads with nonces/timestamps for replay-proof, time-bound key access
- 👥 **Group Management** - Fine-grained access control with event-driven key generation/rotation
- 🔄 **Key Rotation** - Automatic TEE-side rotation on revocation, with on-chain checksum verification
- 🚀 **Composite Operations** - End-to-end workflows: Encrypt → Upload → Authenticate → Retrieve

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
nova-sdk-rs = "0.4.1"
tokio = { version = "1", features = ["full"] }
```

## Quick Start

```rust
use nova_sdk_rs::NovaSdk;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Get your session token from nova-sdk.com/api/auth/session-token
    let session_token = "eyJhbGciOiJIUzI1NiJ9..."; // JWT from nova-sdk.com
    
    // 2. Initialize SDK with your NOVA account and session token
    let sdk = NovaSdk::new(
        "alice-nova.nova-sdk-5.testnet",  // Your NOVA-managed account
        session_token,
    )?;

    // 3. Upload encrypted file (MCP handles: get key → encrypt → IPFS → record tx)
    let result = sdk.composite_upload(
        "secure_project",
        b"Confidential AI dataset",
        "dataset.bin"
    ).await?;

    println!("✅ Uploaded to IPFS: {}", result.cid);
    println!("📝 Transaction ID: {}", result.trans_id);
    println!("🔒 File Hash: {}", result.file_hash);
    println!("💰 Fee: {} NEAR", result.fee_breakdown.total);

    // 4. Retrieve and decrypt (MCP handles: get key → fetch IPFS → decrypt)
    let retrieved = sdk.composite_retrieve(
        "secure_project",
        &result.cid
    ).await?;

    println!("📄 Retrieved {} bytes", retrieved.data.len());
    println!("✅ Hash matches: {}", retrieved.file_hash == result.file_hash);

    Ok(())
}
```

## Getting Your Session Token

Before using the SDK, obtain a session token from nova-sdk.com:

```bash
# For wallet users
curl -X POST https://nova-sdk.com/api/auth/session-token \
  -H "Content-Type: application/json" \
  -d '{"wallet_id": "your-wallet.near"}'

# Response: { "token": "eyJhbG...", "account_id": "you-nova.nova-sdk-5.testnet", "expires_in": 86400 }
```

The session token is valid for 24 hours. Store it securely and refresh before expiry.

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


```rust
// Register new group (owner only)
sdk.register_group("secure_vault").await?;

// Add members
sdk.add_group_member("secure_vault", "bob.testnet").await?;

// Check authorization (direct RPC - no MCP needed)
let authorized = sdk.is_authorized("secure_vault", Some("bob.testnet")).await?;

// Revoke member (automatically rotates key in TEE)
sdk.revoke_group_member("secure_vault", "bob.testnet").await?;
```

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

## API Overview

### Initialization

- `NovaSdk::new(account_id, session_token)` - Create SDK instance

### Group Management

- `register_group(group_id)` - Create new group (triggers TEE key gen via events).
- `add_group_member(group_id, user_id)` - Grant access to user.
- `revoke_group_member(group_id, user_id)` - Revoke access and auto-rotate key in TEE.
- `is_authorized(group_id, user_id)` - Check user authorization.

### File Operations

- `composite_upload(group_id, user_id, data: &[u8], filename)` - Encrypt, upload to IPFS, record transaction (uses TEE key).
- `composite_retrieve(group_id, cid)` - Fetch from IPFS, decrypt (uses TEE key).
- `record_transaction()` - Log metadata (group-member callable).
- `get_transactions_for_group()` - Query transaction history

### Utilities

- `get_balance(account_id)` - Check NEAR account balance
- `transfer_tokens(to_account, amount_yocto)` - Transfer NEAR tokens

## Environment Setup

For testing and development, set these environment variables in a `.env` file:

```bash
# Required for integration tests
TEST_NOVA_ACCOUNT_ID=alice-nova.nova-sdk-5.testnet
TEST_SESSION_TOKEN=eyJhbGciOiJIUzI1NiJ9...  # Get from nova-sdk.com
```

## Testing

```bash
# Run unit tests
cargo test

# Run with integration tests (requires .env setup)
cargo test -- --include-ignored

# Run specific test
cargo test test_composite_upload
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

## Security Considerations

⚠️ **Important Security Notes:**

1. **No On-Chain Keys** - Keys encrypted in TEEs (Phala Shade); only checksums public—RPC scans reveal nothing decryptable.
2. **Ephemeral Tokens** - Ed25519-signed (nonce/timestamp); 5min expiry, replay-proof (used_nonces map).
3. **TEE Verification** - Shade workers attested (code hash); multi-instance sync via shared TEE_SECRET.
4. **Layered Auth** - On-chain membership + token sig + TEE decrypt/checksum—defense against key theft.
5. **Private Keys** - Never commit; use for signing only (ed25519 seed extraction secure).
6. **IPFS**: Public CIDs; rely on encryption—avoid unencrypted uploads.

⚠️ General: Validate checksums in prod; monitor Shade attestations.

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

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/nova/LICENSE) file for details.

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
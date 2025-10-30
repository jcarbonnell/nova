# NOVA SDK for Rust

A Rust SDK for interacting with NOVA secure file-sharing on NEAR blockchain. NOVA v2 hybridizes IPFS storage with Shade Agents and TEEs (via Phala) for verifiable privacy, using ephemeral nonce-based tokens for key access. Files are encrypted client-side and stored off-chain, with on-chain metadata ensuring auditable, group-based controls.

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
nova-sdk-rs = "0.2.0"
tokio = { version = "1", features = ["full"] }
```

## Quick Start

```rust
use nova_sdk_rs::{NovaSdk, CompositeUploadResult};
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize SDK (v2 requires Shade API URL for TEE key fetches)
    let shade_url = env::var("SHADE_API_URL").unwrap_or("https://your-shade.phala.network".to_string());
    let sdk = NovaSdk::new(
        "https://rpc.testnet.near.org",
        "nova-v2-contract.testnet",  // v2 contract
        "your_pinata_api_key",
        "your_pinata_secret_key",
        &shade_url,  // TEE endpoint
    ).with_signer(
        "ed25519:your_private_key",
        "your-account.testnet"
    )?;

    // Upload encrypted file (authenticates via token to TEE for key)
    let result: CompositeUploadResult = sdk.composite_upload(
        "secure_project_v2",
        "alice.testnet",
        b"Confidential AI dataset",
        "dataset.bin"
    ).await?;

    println!("✅ Uploaded to IPFS: {}", result.cid);
    println!("📝 Transaction ID: {}", result.trans_id);
    println!("🔒 File Hash: {}", result.file_hash);

    // Retrieve and decrypt (fetches ephemeral key from TEE)
    let retrieved = sdk.composite_retrieve(
        "secure_project_v2",
        &result.cid
    ).await?;

    let decrypted = &retrieved.data;  // Vec<u8> for binary
    println!("📄 Retrieved {} bytes; hash matches: {}", decrypted.len(), retrieved.file_hash);

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


```rust
// Register new group (owner only)
sdk.register_group("secure_vault").await?;

// Add members
sdk.add_group_member("secure_vault", "bob.testnet").await?;

// Check authorization
let authorized = sdk.is_authorized("secure_vault", "bob.testnet").await?;

// Fetch key from TEE
let key_b64 = sdk.get_group_key("secure_v2", "bob.testnet").await?;

// Revoke member (automatically rotates key)
sdk.revoke_group_member("secure_vault", "bob.testnet").await?;
```

### Encryption

All data is encrypted client-side using AES-256-CBC:
- 256-bit symmetric keys
- Random IV per encryption
- PKCS7 padding
- SHA256 hashing for integrity

### Transaction Recording

Records file metadata (CID/hash) on-chain; now callable by any group member (v2 enhancement).

```rust
let trans_id = sdk.record_transaction(
    "my_group",
    "alice.testnet",
    "file_hash_sha256",
    "QmIPFSHash"
).await?;

// Query group transactions
let txs = sdk.get_transactions_for_group("my_group", "alice.testnet").await?;
```

## API Overview

### Initialization

- `NovaSdk::new(rpc_url, contract_id, pinata_key, pinata_secret, shade_api_url)` - Create SDK instance
- `with_signer(private_key, account_id)` - Attach NEAR signer (ed25519 support for tokens)

### Group Management

- `register_group(group_id)` - Create new group (triggers TEE key gen via events).
- `add_group_member(group_id, user_id)` - Grant access to user.
- `revoke_group_member(group_id, user_id)` - Revoke access and auto-rotate key in TEE.
- `is_authorized(group_id, user_id)` - Check user authorization.

### Key Management (TEE-Ephemeral)

- `store_group_key(group_id, user_id)` - Fetches via token flow (signs payload → claim → Shade decrypt + checksum verify).
- `get_group_key(group_id)` - View on-chain TEE attestation (for manual verification).

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
TEST_NEAR_ACCOUNT_ID=your-account.testnet
TEST_NEAR_PRIVATE_KEY=ed25519:your_private_key
PINATA_API_KEY=your_pinata_key
PINATA_SECRET_KEY=your_pinata_secret
SHADE_API_URL=https://your-shade.phala.network
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

match sdk.get_group_key("my_group", "user.testnet").await {
    Ok(key) => println!("Key: {}", key),
    Err(NovaError::Near(msg)) => eprintln!("RPC error: {}", msg),
    Err(NovaError::Shade(msg)) => eprintln!("TEE: {}", msg),
    Err(NovaError::ChecksumMismatch) => eprintln!("TEE attestation failed"),
    Err(NovaError::InvalidKey) => eprintln!("Invalid encryption key"),
    Err(NovaError::ParseAccount) => eprintln!("Invalid account ID"),
    Err(NovaError::Signing(msg)) => eprintln!("Signing failed: {}", msg),
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
- `key_rotation.rs` - Handling member revocation

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
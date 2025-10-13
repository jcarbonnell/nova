# NOVA SDK for Rust

A Rust SDK for interacting with NOVA secure file-sharing on NEAR blockchain. Provides encrypted, decentralized file storage using IPFS and NEAR smart contracts with group-based access control.

## Features

- 🔐 **AES-256-CBC Encryption** - Client-side encryption for data privacy
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and access control
- 👥 **Group Management** - Fine-grained access control with member authorization
- 🔑 **Key Rotation** - Automatic key rotation on member revocation
- 🚀 **Composite Operations** - Simplified high-level workflows

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
nova-sdk-rs = "0.1.0"
tokio = { version = "1", features = ["full"] }
```

## Quick Start

```rust
use nova_sdk_rs::{NovaSdk, CompositeUploadResult};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize SDK
    let sdk = NovaSdk::new(
        "https://rpc.testnet.near.org",
        "nova-contract.testnet",
        "your_pinata_api_key",
        "your_pinata_secret_key"
    ).with_signer(
        "ed25519:your_private_key",
        "your-account.testnet"
    )?;

    // Upload encrypted file
    let result = sdk.composite_upload(
        "project_alpha",           // group_id
        "alice.testnet",           // user_id
        "Confidential data",       // data
        "report.txt"               // filename
    ).await?;

    println!("✅ Uploaded to IPFS: {}", result.cid);
    println!("📝 Transaction ID: {}", result.trans_id);
    println!("🔒 File Hash: {}", result.file_hash);

    // Retrieve and decrypt file
    let retrieved = sdk.composite_retrieve(
        "project_alpha",
        &result.cid
    ).await?;

    let decrypted = base64::engine::general_purpose::STANDARD
        .decode(&retrieved.decrypted_b64)?;
    let content = String::from_utf8(decrypted)?;
    
    println!("📄 Content: {}", content);

    Ok(())
}
```

## Core Concepts

### Groups

Groups provide isolated access control domains. Each group has:
- A unique identifier (`group_id`)
- An owner who manages membership
- A shared encryption key
- A list of authorized members

### Access Control

```rust
// Register new group (owner only)
sdk.register_group("secure_vault").await?;

// Add members
sdk.add_group_member("secure_vault", "bob.testnet").await?;

// Check authorization
let authorized = sdk.is_authorized("secure_vault", "bob.testnet").await?;

// Revoke member (automatically rotates key)
sdk.revoke_group_member("secure_vault", "bob.testnet").await?;
```

### Encryption

All data is encrypted client-side using AES-256-CBC:
- 256-bit symmetric keys
- Random IV per encryption
- PKCS7 padding
- Keys stored encrypted on blockchain

### Transaction Recording

Every file operation creates an immutable blockchain record:

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

- `NovaSdk::new()` - Create SDK instance
- `with_signer()` - Attach NEAR account credentials

### Group Management

- `register_group()` - Create new group
- `add_group_member()` - Grant access to user
- `revoke_group_member()` - Revoke access and rotate key
- `is_authorized()` - Check user authorization

### Key Management

- `store_group_key()` - Store encryption key
- `get_group_key()` - Retrieve key (authorized users only)

### File Operations

- `composite_upload()` - Encrypt, upload to IPFS, record transaction
- `composite_retrieve()` - Fetch from IPFS, decrypt
- `record_transaction()` - Record file metadata on blockchain
- `get_transactions_for_group()` - Query transaction history

### Utilities

- `get_balance()` - Check NEAR account balance
- `transfer_tokens()` - Transfer NEAR tokens

## Environment Setup

For testing and development, set these environment variables:

```bash
# Required for integration tests
TEST_NEAR_ACCOUNT_ID=your-account.testnet
TEST_NEAR_PRIVATE_KEY=ed25519:your_private_key
PINATA_API_KEY=your_pinata_key
PINATA_SECRET_KEY=your_pinata_secret
```

Create a `.env` file:

```bash
TEST_NEAR_ACCOUNT_ID=alice.testnet
TEST_NEAR_PRIVATE_KEY=ed25519:...
PINATA_API_KEY=...
PINATA_SECRET_KEY=...
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
    Err(NovaError::InvalidKey) => eprintln!("Invalid encryption key"),
    Err(NovaError::ParseAccount) => eprintln!("Invalid account ID"),
    Err(NovaError::Signing(msg)) => eprintln!("Signing failed: {}", msg),
}
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Never commit private keys to version control
2. **Key Storage** - Store encryption keys securely
3. **IPFS Privacy** - IPFS content is public; encryption is essential
4. **Access Control** - Verify user authorization before operations
5. **Key Rotation** - Revoked members cannot decrypt new content

## Examples

See the [examples](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-rs/examples) directory for complete working examples:

- `simple_upload.rs` - Basic file upload/download
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

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/nova/blob/main/nova-sdk-rs/LICENSE) file for details.

## Resources

- [NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)
- [NEAR Protocol](https://near.org)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
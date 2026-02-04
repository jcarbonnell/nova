# NOVA Secure File-Sharing

NOVA is a privacy-first, decentralized file-sharing primitive, empowering user-owned AI at scale with encryted data persistence. NOVA enables secure storage and sharing of sensitive data (e.g., datasets for AI agent fine-tuning) without centralized intermediaries, leveraging group key management, IPFS, NEAR smart contracts, and verifiable TEEs via Shade Agents.

NOVA fills critical gaps in NEAR’s ecosystem —no native encrypted persistence for TEEs, Intents, or Shade Agents— while inheriting NEAR’s strengths like sharding for scalability, low-cost transactions (~0.01 NEAR/gas), and AI-native tools (e.g., NEAR AI CLI). Whether you're building AI social platforms, DeFi apps, or autonomous agent workflows, NOVA provides a secure, verifiable data layer.

**Dual-Network Support**: Use mainnet for production [nova-sdk.com](https://nova-sdk.com) or testnet for development [testnet.nova-sdk.com](https://testnet.nova-sdk.com). Testnet uses mocked IPFS for free testing; mainnet uses real Pinata integration (paid).

## Why Use NOVA?

- **Privacy-First**: Encrypt files with group keys managed off-chain in TEEs, ensuring only authorized users or AI agents access data—keys never exposed on-chain.
- **Decentralized**: Store files on IPFS, log metadata on NEAR’s immutable ledger, and manage access via smart contracts. No central servers.
- **AI-Ready**: Seamlessly integrates with NEAR’s TEEs, Intents, and Shade Agents, enabling secure data for AI training and execution.
- **Developer-Friendly**: Free-to-integrate SDKs (Rust crate and JS package) with pay-per-action fees baked into the contract, blending into your dApp’s backend.

## Key Features

- **Group Creation & Management**: Owners (NEAR AccountIds) create groups via smart contracts, supporting collaborative AI training with multi-group membership. Anyone can create groups (per future update—currently owner-gated for MVP stability).
- **Access Control**: Smart contracts maintain a mapping table for members and attestations, ensuring only authorized users access files via ephemeral tokens. Vital for user-owned AI privacy.
- **Secure Storage**: Files are encrypted with group keys and pinned to IPFS, optimized for AI dApps (e.g., datasets for fine-tuning).
- **Access Workflow**: SDKs retrieve encryption keys from TEE via secure tokens, then perform client-side encryption/decryption —plaintext data never leaves your device or server.
- **Revocation & Key Rotation**: Remove members and rotate keys in TEEs with lazy re-encryption to minimize latency/gas costs for large groups.
- **Integrity & Trackability**: Log signed transactions (with file hashes) on-chain for non-corruption guarantees, leveraging NEAR’s ledger for verifiability.

## Group Key Security

**Keys are managed off-chain in verifiable TEEs via Shade Agents. Never published on-chain, NOVA file-sharing ensures unbreakable privacy against blockchain fetches.**

NOVA's keys are generated, stored, and distributed exclusively within Trusted Execution Environments (TEEs) using Shade Agents. This eliminates any on-chain exposure:
- **Off-Chain Key Management**: Keys are derived and encrypted in TEE-secure SQLite databases, accessible only by verified Shade workers (multi-instance with identical code hashes for redundancy and shared access).
- **No On-Chain Keys**: The smart contract stores only group metadata, attestations (checksums/code hashes), and used nonces—no keys or decryptable data. RPC queries (e.g., view_state) reveal nothing sensitive.
- **Secure Distribution**: Users request ephemeral nonce-based access tokens from the contract (gated by on-chain membership). Tokens incorporate a timestamp-derived SHA256 nonce (preventing replay attacks) and are verified in-TEE before key release, ensuring single-use validity without shared secrets.
- **Verification & Attestation**: Every key operation returns a TEE checksum (via agentInfo), proving execution in genuine hardware with unmodified code—no tampering possible.
- **Rotation & Revocation**: On member removal, keys rotate in-TEE (new derivation), invalidating prior access without re-encryption overhead.
- **Attack Resistance**: Even targeted attacks (e.g., indexing interactions or RPC dumps) can't extract keys: they're never on-chain. High-value targets (e.g., AI datasets) remain secure against nation-state or sophisticated threats.

NOVA's architecture combined with Shade/TEEs confidentiality provides bullet-proof security for your data: verifiable, private, and resilient, aligning with NEAR's user-owned AI vision.

## NOVA x NEAR

NOVA complements NEAR’s AI-focused tools:
- **TEEs**: Secures data at rest/transit for confidential compute (e.g., private AI inference in Phala enclaves).
- **Intents**: Gates solver access to encrypted payloads, enabling private, AI-driven fulfillment (e.g., cross-chain swaps).
- **Shade Agents**: Persists off-chain data for autonomous workers, resolving the "oracle problem" with verified inputs (e.g., prediction markets).

## Integration Options

Choose the integration that best fits your use case:

### 🤖 MCP Server - AI Assistant Integration

For AI-assisted workflows using Claude or other MCP-compatible assistants, integrate the publicly deployed https://nova-mcp.fastmcp.app/mcp as a custom connector in your mcp client.

You can also interact with NOVA directly from its multi-user interface at [https://nova-sdk.com](https://nova-sdk.com)

**Best for**: Natural language file operations, AI agent workflows, conversational interfaces

**Documentation**: [/mcp-server](./mcp-server) | [GitBook](https://nova-25.gitbook.io/nova-docs/)

---

### 📦 JavaScript SDK - Web & Node.js

For web applications, backend services, and Node.js environments.

```bash
npm install nova-sdk-js
```

**Best for**: Web dApps, API servers, browser applications, TypeScript projects

**Documentation**: [/nova-sdk-js](./nova-sdk-js) | [GitBook](https://nova-25.gitbook.io/nova-docs/)

---

### 🦀 Rust SDK - System & Smart Contract Integration

For high-performance applications, blockchain integration, and system-level development.

```toml
[dependencies]
nova-sdk-rs = "1.0.3"
```

**Best for**: Smart contracts, CLI tools, high-performance services, native applications

**Documentation**: [/nova-sdk-rs](./nova-sdk-rs) | [GitBook](https://nova-25.gitbook.io/nova-docs/)

---

## Quick Start Examples

### Web Interface 

Visit **[nova-sdk.com](https://nova-sdk.com)** to:
1. **Login** with email or social (Google/Apple/GitHub)
2. **Create your NEAR account** automatically (no wallet needed!)
3. **Upload files** through natural language chat
```
You: "Create a group called 'research_team' and upload my dataset securely"
NOVA chat: ✅ Group created! Uploading... 
        📦 File encrypted and uploaded to IPFS
        🔗 Transaction recorded: https://nearblocks.io/txns/ABC123...
```

### JavaScript/Typescript SDK
```typescript
import { NovaSdk } from 'nova-sdk-js';
import fs from 'fs';

// Initialize SDK with your account and session token
// Get these from https://nova-sdk.com after login
const sdk = new NovaSdk(
  'alice.nova-sdk.near',  // Your NEAR account
  {
    apiKey: process.env.NOVA_API_KEY,  // From nova-sdk.com
  }
);

// Check your network (mainnet by default)
console.log(sdk.getNetworkInfo());
// { networkId: 'mainnet', contractId: 'nova-sdk.near', ... }

// Register a new group (you become owner)
await sdk.registerGroup('my-private-files');

// Upload encrypted file (client-side encryption)
const fileData = fs.readFileSync('./sensitive-doc.pdf');
const result = await sdk.upload(
  'my-private-files',   // group_id
  fileData,             // file data (Buffer)
  'sensitive-doc.pdf'   // filename
);

console.log('✅ Uploaded!');
console.log('📦 IPFS CID:', result.cid);
console.log('🔗 Transaction:', result.trans_id);

// Retrieve and decrypt file (client-side decryption)
const { data } = await sdk.retrieve(
  'my-private-files',
  result.cid  // IPFS hash from upload
);

fs.writeFileSync('./decrypted-doc.pdf', data);
console.log('✅ File decrypted!');
```

### Rust SDK
```rust
use nova_sdk_rs::{NovaSdk, NovaSdkConfig};
use std::fs;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize SDK (mainnet by default)
    let config = NovaSdkConfig::default()
        .with_api_key(&std::env::var("NOVA_API_KEY")?);
    let sdk = NovaSdk::with_config("alice.nova-sdk.near", config)?;

    // Check network
    let (network, contract, _) = sdk.get_network_info();
    println!("Network: {} | Contract: {}", network, contract);

    // Register group
    sdk.register_group("my-secure-files").await?;

    // Upload file (client-side encryption)
    let file_data = fs::read("./confidential.pdf")?;
    let result = sdk.upload(
        "my-secure-files",
        &file_data,
        "confidential.pdf"
    ).await?;

    println!("✅ Uploaded!");
    println!("📦 IPFS CID: {}", result.cid);
    println!("🔗 Transaction: {}", result.trans_id);

    // Retrieve file (client-side decryption)
    let retrieved = sdk.retrieve(
        "my-secure-files",
        &result.cid
    ).await?;

    fs::write("./decrypted.pdf", &retrieved.data)?;
    println!("✅ File decrypted!");

    Ok(())
}
```

### 🧪 Testnet Usage

⚠️ **Testnet Mode**: IPFS uploads are mocked on testnet - files are stored in-memory and not persisted to IPFS. Blockchain operations (group registration, member management) are real and use faucet tokens on nova-sdk-6.testnet.

For development, use **testnet** explicitly:

**JavaScript:**
```typescript
const sdk = new NovaSdk('alice.nova-sdk-6.testnet', {
  apiKey: process.env.NOVA_API_KEY,
  rpcUrl: 'https://rpc.testnet.near.org',
  contractId: 'nova-sdk-6.testnet',
});
```

**Rust:**
```rust
let config = NovaSdkConfig::testnet()
    .with_api_key(&std::env::var("NOVA_API_KEY")?);

let sdk = NovaSdk::with_config("alice.nova-sdk-6.testnet", config)?;
```


## Architecture

```
┌─────────────────┐
│   Your dApp     │
│  (MCP/JS/Rust)  │
└────────┬────────┘
         │ Session Token (JWT)
    ┌────┴────┐
    │  NOVA   │
    │   SDK   │  ← No private keys!
    └────┬────┘
         │
    ┌────┴─────────────────────────────┐
    │         MCP Server               │
    │  (Auth + Signing Proxy)          │
    └─┬───────────────┬────────────────┘
      │               │                │
┌─────▼──┐      ┌─────▼─────┐        ┌─▼─────────┐
│  IPFS  │      │   NEAR    │        │ Shade/TEE │
│(Pinata)│      │ Blockchain│        │ (key ops) │
└────────┘      └───────────┘        └───────────┘
 Encrypted       Access Control        Keys Never
   Storage        & Group Metadata      Exposed
```

**Flow:**
1. **User authenticates** via API key (get yours at nova-sdk.com)
2. **SDK sends request** to MCP server with session token (auto-managed)
3. **MCP verifies JWT** → retrieves encryption key from Shade TEE
4. **SDK encrypts locally** using AES-256-GCM (key never leaves client unencrypted)
5. **MCP uploads encrypted data** to IPFS and records transaction on NEAR
6. **Shade Agent** manages keys in TEE (never exposed on-chain)
7. **IPFS stores** encrypted files (ciphertext only)
8. **NEAR records** transaction metadata (CID, file hash)


## Use Cases

### 🤖 AI & Machine Learning
- **Dataset Sharing**: Securely share training data between researchers
- **Model Fine-Tuning**: Store and access sensitive data for AI agent training
- **TEE Integration**: Encrypted inputs/outputs to confidential compute environments

### 🏢 Enterprise & Collaboration
- **Document Sharing**: Secure file sharing within organizations
- **Access Revocation**: Remove member access and rotate keys automatically
- **Audit Trails**: Immutable transaction logs on NEAR blockchain

### 🔐 Privacy-Preserving Applications
- **Healthcare Records**: HIPAA-compliant data sharing
- **Financial Data**: Secure transmission of sensitive financial information
- **Identity Documents**: User-controlled identity verification data

## NEAR Token Requirements

Operations require small NEAR deposits:

- Register group: ~0.1 NEAR
- Add member: ~0.0005 NEAR
- Revoke member: ~0.0005 NEAR
- Retrieve file: ~0.001 NEAR
- Upload file: ~0.01 NEAR

Ensure your NEAR account has sufficient balance before operations.

## Documentation

Comprehensive documentation is available on GitBook:

📚 **[NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)**

### Quick Links
- [Quick Start Examples](https://nova-25.gitbook.io/nova-docs#quick-start-examples)
- [MCP Server Guide](https://nova-25.gitbook.io/nova-docs/mcp-server)
- [JavaScript SDK Reference](https://nova-25.gitbook.io/nova-docs/nova-sdk-js)
- [Rust SDK Reference](https://nova-25.gitbook.io/nova-docs/nova-sdk-rs)
- [NOVA Shade Agent](https://nova-25.gitbook.io/nova-docs/shade-agent)
- [Architecture & Concepts](https://nova-25.gitbook.io/nova-docs#architecture)

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Never publish NEAR private keys to version control
2. **Key Storage** - Keys managed in TEEs; never handle plaintext in code
3. **IPFS Privacy** - IPFS content is addressable by CID; encryption is essential
4. **Access Control** - Always verify user authorization before operations
5. **Key Rotation** - Revoked members cannot decrypt content uploaded after revocation
6. **Client-Side Encryption** - Files are encrypted locally using AES-256-GCM; plaintext never transmitted to IPFS or MCP server
7. **Token Ephemerality** - Nonces and timestamps prevent replay; session tokens auto-refresh
8. **API Key Security** - Store API keys in environment variables; never commit to version control


## Future Roadmap

### Potential Enhancements
- **AI Metadata Extraction**: Automate metadata extraction for optimized IPFS indexing.
- **Dataset Monetization**: Add pricing for file access/downloads.
- **Per-user rights**: So far all group members can upload files in the group. This could be controllable with per-member rights to be set at add member or later updated.
- **Chainlink Oracles**: Dynamic fee calculation (NEAR/USD + IPFS storage costs)
- **Multi-Chain Support**: Expand to other NEAR-compatible chains

## Contributing

Contributions are welcome! We accept contributions for:
- Bug fixes and improvements
- New SDK features
- Documentation enhancements
- Integration examples
- Test coverage

### How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Add tests for new functionality
4. Ensure all tests pass
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

See individual SDK directories for specific testing instructions.

## Resources

### NOVA Resources
- [Documentation](https://nova-25.gitbook.io/nova-docs/)
- [GitHub Repository](https://github.com/jcarbonnell/nova)
- [Issues](https://github.com/jcarbonnell/nova/issues)
- [Discussions](https://github.com/jcarbonnell/nova/discussions)

### NEAR Resources
- [NEAR Protocol](https://near.org)
- [NEAR Documentation](https://docs.near.org)
- [NEAR JavaScript API](https://docs.near.org/tools/near-api-js/quick-reference)
- [Create NEAR Account](https://app.mynearwallet.com/)

### Storage Resources
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)

### AI Integration
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Claude Desktop](https://claude.ai/desktop)
- [NEAR AI](https://near.ai)

## Support

Need help? We're here for you:

- **Issues**: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
- **Documentation**: [GitBook](https://nova-25.gitbook.io/nova-docs/)

## License

MIT [LICENSE](LICENSE) - Copyright (c) 2026 CivicTech OÜ

## Acknowledgments

Built with ❤️ for the NEAR ecosystem, leveraging:
- NEAR Protocol for decentralized access control
- IPFS/Pinata for decentralized storage
- Shade Agents & TEEs for verifiable key management
- Model Context Protocol for AI integration

---

**Ready to build privacy-first dApps?** Choose your integration: [MCP](./mcp-server) | [JavaScript](./nova-sdk-js) | [Rust](./nova-sdk-rs)
# NOVA  - Persistent memory for AI agents

NOVA is a privacy-first data layer primitive, empowering AI agents with an encrypted, auditable, and self-sovereign memory. NOVA enables the secure storage and sharing of sensitive data (e.g., a private conversation with your AI agent) without centralized intermediaries, leveraging group key management,  FastFS (NEAR-native storage), NEAR smart contracts, and verifiable Trusted Execution Environments via Shade Agents.

NOVA fills critical gaps in AI ecosystems —no native encrypted data persistence across agents— while inheriting NEAR Protocol’s strengths like sharding for scalability, low-cost transactions (~0.01 NEAR/gas), and AI-native tools (e.g., NEAR AI CLI). Whether you're building AI social platforms, DeFi apps, or autonomous agent workflows, NOVA provides a secure, verifiable data layer, protable across your LLMs and persistent beyond any model lifetime.

**Dual-Network Support**: Use mainnet for production [nova-sdk.com](https://nova-sdk.com) or testnet for development [testnet.nova-sdk.com](https://testnet.nova-sdk.com). Testnet uses mocked storage for free testing; mainnet stores files on FastFS (NEAR-native).

## Why Use NOVA?

- **Privacy-First**: Encrypt files with group keys managed off-chain in TEEs, ensuring only authorized users or AI agents access data—keys never exposed on-chain.
- **Decentralized**: Store files on FastFS (durability rooted in NEAR block history), log metadata on NEAR’s immutable ledger, and manage access via smart contracts. No central servers.
- **AI-Ready**: Seamlessly integrates with NEAR’s TEEs, Intents, and Shade Agents, enabling secure data for AI training and execution.
- **Developer-Friendly**: Free-to-integrate SDKs (Rust crate and JS package) with pay-per-action fees baked into the contract, blending into your dApp’s backend.

## Key Features

- **Group Creation & Management**: Anyone can create a group via the smart contract and becomes its owner, supporting self-sovereign AI workflows with multi-group membership. Owners manage membership; open groups additionally support self-service join.
- **Access Control**: Smart contracts maintain a mapping table for members and attestations, ensuring only authorized users access files via ephemeral tokens. Vital for user-owned AI privacy.
- **Secure Storage**: Files are encrypted with per-file keys (wrapped under the group key) and stored on FastFS, optimized for AI dApps (e.g., datasets for fine-tuning). Deletion crypto-shreds a file's key and tombstones its record — real removal, not just unpinning.
- **Access Workflow**: SDKs retrieve encryption keys from TEE via secure tokens, then perform client-side encryption/decryption —plaintext data never leaves your device or server.
- **Revocation & Key Rotation**: Remove members and rotate the group key in the TEE so a revoked member cannot decrypt files uploaded after revocation.
- **Integrity & Trackability**: Log signed transactions (with file hashes) on-chain for non-corruption guarantees, leveraging NEAR’s ledger for verifiability.

## Group Key Security

**Keys are managed off-chain in verifiable TEEs via Shade Agents. Never published on-chain, NOVA file-sharing ensures unbreakable privacy against blockchain fetches.**

NOVA's keys are generated, stored, and distributed exclusively within Trusted Execution Environments (TEEs) using Shade Agents. This eliminates any on-chain exposure:
- **Off-Chain Key Management**: Keys are derived via HKDF from a master seed and encrypted with AES-256-GCM inside the TEE (one legacy blob, the master-root, remains AES-256-CBC and is read transparently for backward compatibility; all new writes are GCM). Encrypted blobs are stored on-chain in `nova-kv.near` — a purpose-built NEAR smart contract — accessible only by the Shade Agent's deterministic signer key, registered with minimal FunctionCall permission scope.
- **No On-Chain Keys**: The smart contract stores only group metadata, attestations (checksums/code hashes), and used nonces—no keys or decryptable data. RPC queries (e.g., view_state) reveal nothing sensitive.
- **Secure Distribution**: Users request ephemeral nonce-based access tokens from the contract (gated by on-chain membership). Tokens incorporate a timestamp and nonce verified in-TEE before key release. Group keys are derived deterministically from a master seed using HKDF — the same key is always re-derived for the same group, making keys stateless and recoverable across TEE restarts.
- **Verification & Attestation**: Every key operation returns a TEE checksum (via agentInfo), proving execution in genuine hardware with unmodified code—no tampering possible.
- **Rotation & Revocation**: On member removal, membership is revoked on-chain and the group key is rotated off-chain in the TEE — a new versioned salt is derived and the rotated key is stored on `nova-kv.near`, so the revoked member cannot decrypt files uploaded after revocation.
- **Attack Resistance**: Even targeted attacks (e.g., indexing interactions or RPC dumps) can't extract keys: they're never on-chain. High-value targets (e.g., AI datasets) remain secure against nation-state or sophisticated threats.

NOVA's architecture combined with Shade/TEEs confidentiality provides bullet-proof security for your data: verifiable, private, and resilient, aligning with NEAR's user-owned AI vision.

## NOVA x NEAR

NOVA complements NEAR’s AI-focused tools:
- **TEEs**: Secures data at rest/transit for confidential compute (e.g., private AI inference in Phala enclaves).
- **Intents**: Gates solver access to encrypted payloads, enabling private, AI-driven fulfillment (e.g., cross-chain swaps).
- **Shade Agents**: Persists off-chain data for autonomous workers, resolving the "oracle problem" with verified inputs (e.g., prediction markets).

## Integration Options

Choose the integration that best fits your use case:

### 🤖 Claude Plugin - AI Assistant Integration

For AI-assisted workflows, install the `nova-ai-memory` plugin in Claude Code or Claude Cowork — it exposes NOVA's store, retrieve, list, and group-management tools natively. No wallet, no NEAR knowledge, just an API key; encryption stays client-side on your machine.

/plugin marketplace add anthropics/claude-plugins-community
/plugin install nova-ai-memory@claude-community

On install you enter your NOVA Account ID and API key (stored in your OS keychain). Then ask your agent: "Which group do I own?" or "Upload these notes to my research group." You can also interact with NOVA directly from its multi-user interface at [https://nova-sdk.com](https://nova-sdk.com)

**Best for**: Natural language file operations, AI agent workflows, conversational interfaces. *(Codex/ChatGPT support is on the roadmap.)*

**IronClaw tool**: For agent-side encrypted uploads, use [nova-submit](./nova-submit-tool) — a self-contained IronClaw WASM tool that AES-256-GCM-encrypts a file and uploads it to a NOVA group in one call, with the crypto compiled in so the agent's model never touches keys or ciphertext.

**Documentation**: [/nova-ai-memory](./nova-ai-memory) | [GitBook](https://civictech-ou.gitbook.io/nova-docs/)

---

### 📦 JavaScript SDK - Web & Node.js

For web applications, backend services, and Node.js environments.

```bash
npm install nova-sdk-js
```

**Best for**: Web dApps, API servers, browser applications, TypeScript projects

**Documentation**: [/nova-sdk-js](./nova-sdk-js) | [GitBook](https://civictech-ou.gitbook.io/nova-docs/)

---

### 🦀 Rust SDK - System & Smart Contract Integration

For high-performance applications, blockchain integration, and system-level development.

```toml
[dependencies]
nova-sdk-rs = "1.2.3"
```

**Best for**: Smart contracts, CLI tools, high-performance services, native applications

**Documentation**: [/nova-sdk-rs](./nova-sdk-rs) | [GitBook](https://civictech-ou.gitbook.io/nova-docs/)

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
        📦 File encrypted and stored on FastFS
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
console.log('📦 Ref:', result.cid);  // FastFS location
console.log('🔗 Transaction:', result.trans_id);

// Retrieve and decrypt file (client-side decryption)
const { data } = await sdk.retrieve(
  'my-private-files',
  result.cid  // storage ref from upload
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

    println!("✅ Uploaded!");
    println!("📦 Ref: {}", result.cid);  // FastFS location
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

⚠️ **Testnet Mode**: file uploads are mocked on testnet - files are stored in-memory and not persisted. Blockchain operations (group registration, member management) are real and use faucet tokens on nova-sdk-6.testnet.

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
│ FastFS │      │   NEAR    │        │ Shade/TEE │
│        │      │ Blockchain│        │ (key ops) │
└────────┘      └─────┬─────┘        └───────────┘
 Encrypted       nova-sdk.near          Keys Never
   Storage       nova-kv.near           Exposed
                 (encrypted blobs)
```

**Flow:**
1. **User authenticates** via API key (get yours at nova-sdk.com)
2. **SDK sends request** to MCP server with session token (auto-managed)
3. **MCP verifies JWT** → retrieves encryption key from Shade TEE
4. **SDK encrypts locally** using AES-256-GCM (key never leaves client unencrypted)
5. **MCP writes encrypted data** to FastFS and records transaction on NEAR
6. **Shade Agent** derives keys in TEE via HKDF and stores encrypted blobs on `nova-kv.near` — keys are never exposed in plaintext on-chain
7. **FastFS stores** encrypted files (ciphertext only), durability rooted in NEAR block history
8. **NEAR records** transaction metadata (location, file hash)


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
- **Healthcare Records**: privacy-preserving, HIPAA-aligned data sharing (NOVA provides the encryption and auditable-access primitives; it is not itself a certified compliance product)
- **Financial Data**: Secure transmission of sensitive financial information
- **Identity Documents**: User-controlled identity verification data

## NEAR Token Requirements

Operations require small NEAR deposits:

- Register group: ~0.64 NEAR
- Add member: ~0.013 NEAR
- Revoke member: ~0.001 NEAR
- Retrieve file: ~0.013 NEAR
- Upload file: ~0.039 NEAR

Ensure your NEAR account has sufficient balance before operations.

## Documentation

Comprehensive documentation is available on GitBook:

📚 **[NOVA Documentation](https://civictech-ou.gitbook.io/nova-docs/)**

### Quick Links
- [Quick Start Examples](https://civictech-ou.gitbook.io/nova-docs#quick-start-examples)
- [MCP Server Guide](https://civictech-ou.gitbook.io/nova-docs/mcp-server)
- [JavaScript SDK Reference](https://civictech-ou.gitbook.io/nova-docs/nova-sdk-js)
- [Rust SDK Reference](https://civictech-ou.gitbook.io/nova-docs/nova-sdk-rs)
- [NOVA Shade Agent](https://civictech-ou.gitbook.io/nova-docs/shade-agent)
- [Architecture & Concepts](https://civictech-ou.gitbook.io/nova-docs#architecture)

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Never publish NEAR private keys to version control
2. **Key Storage** - Keys managed in TEEs; never handle plaintext in code
3. **Storage Privacy** - stored content is addressable by reference; client-side encryption is essential
4. **Access Control** - Always verify user authorization before operations
5. **Key Rotation** - Revoked members cannot decrypt content uploaded after revocation
6. **Client-Side Encryption** - Files are encrypted locally using AES-256-GCM; plaintext never transmitted to FastFS or MCP server
7. **Token Ephemerality** - Nonces and timestamps prevent replay; session tokens auto-refresh
8. **API Key Security** - Store API keys in environment variables; never commit to version control


## Future Roadmap

### In Progress
- **Off-chain retention driver**: Per-group retention windows and file deletion are live on-chain (`set_group_retention`, `get_expired_transactions`, `tombstone_transactions`); the scheduled off-chain driver that reads expired files and tombstones them is the last remaining backend piece.
- **Codex / ChatGPT plugin**: The Claude plugin (`nova-ai-memory`) is shipped. A Codex/ChatGPT equivalent is deferred — those surfaces require a hosted MCP endpoint consumed by a cloud agent, which is incompatible with NOVA's client-side encryption model (plaintext and keys never leave the user's machine). NOVA ships there unchanged if/when they support local, client-side-encrypting plugins in their public directories.
- **Cold master-seed backup**: NOVA accounts and group keys persist on `nova-kv.near` and recover across TEE restarts via the master seed. Remaining risk is master seed loss — a cold backup mechanism for the encrypted master seed blob is on the roadmap.

### Potential Enhancements
- **AI Metadata Extraction**: Automate metadata extraction for optimized storage indexing.
- **Dataset Monetization**: Add pricing for file access/downloads.
- **Per-user rights**: So far all group members can upload files in the group. This could be controllable with per-member rights to be set at add member or later updated.
- **Chainlink Oracles**: Dynamic fee calculation (NEAR/USD + storage costs)
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
- [Documentation](https://civictech-ou.gitbook.io/nova-docs/)
- [GitHub Repository](https://github.com/jcarbonnell/nova)
- [Issues](https://github.com/jcarbonnell/nova/issues)
- [Discussions](https://github.com/jcarbonnell/nova/discussions)

### NEAR Resources
- [NEAR Protocol](https://near.org)
- [NEAR Documentation](https://docs.near.org)
- [NEAR JavaScript API](https://docs.near.org/tools/near-api-js/quick-reference)
- [Create NEAR Account](https://app.mynearwallet.com/)

### Storage Resources
- [FastFS](https://fastfs.io)
- [IPFS](https://ipfs.io) (legacy reads)
- [Pinata](https://pinata.cloud) (legacy reads)

### AI Integration
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Claude Desktop](https://claude.ai/desktop)
- [NEAR AI](https://near.ai)

## Support

Need help? We're here for you:

- **Issues**: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- **Discussions**: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
- **Documentation**: [GitBook](https://civictech-ou.gitbook.io/nova-docs/)

## License

MIT [LICENSE](LICENSE) - Copyright (c) 2026 CivicTech OÜ

## Acknowledgments

Built with ❤️ for the NEAR ecosystem, leveraging:
- NEAR Protocol for decentralized access control
- FastFS for NEAR-native decentralized storage
- Shade Agents & TEEs for verifiable key management
- Model Context Protocol for AI integration

---

**Ready to build privacy-first dApps?** Choose your integration: [MCP](./mcp-server) | [JavaScript](./nova-sdk-js) | [Rust](./nova-sdk-rs)
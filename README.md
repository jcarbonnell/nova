# NOVA secure file-sharing

NOVA is a privacy-first, decentralized file-sharing primitive for NEAR dApps, empowering user-owned AI at scale. NOVA enables secure storage and sharing of sensitive data (e.g., datasets for AI agent fine-tuning) without centralized intermediaries, leveraging group key management, IPFS, and NEAR smart contracts.

NOVA fills critical gaps in NEAR’s ecosystem —no native encrypted persistence for TEEs, Intents, or Shade Agents— while inheriting NEAR’s strengths like sharding for scalability, low-cost transactions (~0.01 NEAR/gas), and AI-native tools (e.g., NEAR AI CLI). Whether you're building AI social platforms, DeFi apps, or autonomous agent workflows, NOVA provides a secure, verifiable data layer.

## Why Use NOVA?

- **Privacy-First**: Encrypt files with group keys, ensuring only authorized users or AI agents access data, critical for AI data pipelines where tampering could bias models.
- **Decentralized**: Store files on IPFS, log metadata on NEAR’s immutable ledger, and manage access via smart contracts. No central servers.
- **AI-Ready**: Seamlessly integrates with NEAR’s TEEs, Intents, and Shade Agents, enabling secure data for AI training and execution.
- **Developer-Friendly**: Free-to-integrate SDK (Rust crate and JS package) with pay-per-action fees baked into the contract, blending into your dApp’s backend.

## Key Features

- **Group Creation & Management**: Owners (NEAR AccountIds) create groups via smart contracts, supporting collaborative AI training with multi-group membership.
- **Access Control**: Smart contracts maintain a mapping table for group keys and members, ensuring only authorized users access files, vital for user-owned AI privacy.
- **Secure Storage**: Files are encrypted with group keys and pinned to IPFS, optimized for AI dApps (e.g., datasets for fine-tuning).
- **Access Workflow**: Authorized users query on-chain metadata, retrieve encrypted files from IPFS, and receive wrapped keys for local decryption, ensuring verifiable access.
- **Revocation & Key Rotation**: Remove members and rotate keys with lazy re-encryption to minimize latency/gas costs for large groups.
- **Integrity & Trackability**: Log signed transactions (with file hashes) on-chain for non-corruption guarantees, leveraging NEAR’s ledger for verifiability.

## Group Key Security:

**The group key is not published publicly in a way that allows unrestricted access by anyone.**

While the group key is stored on-chain in the NEAR smart contract's state (as a base64-encoded string in the groups map), retrieval is strictly gated by access controls enforced at the contract level. This keeps the key private and secure, even though it's on a public blockchain.

NEAR contract state isn't "broadcast" or queryable like public variables. Instead, access requires explicit view calls to methods like get_group_key(group_id, user_id), which include built-in authorization checks. You must provide a valid private_key and account_id (matching a group member) to make the view call—the contract verifies is_authorized by scanning the group_members vector for the user_id. If not a member, it panics with "Unauthorized," preventing key return. Signed calls (via SDKs/MCP) use the caller's authenticated predecessor_account_id for enforcement.

In short: keys are fetchable only by verified members, with revocation (remove + rotate) ensuring non-members can't access future data. No key leaks via raw state dumps (RPCs respect logic); future extensions (e.g., TEE-gated or asymmetric wrapping) will add layers without redesign.

## NOVA x NEAR

NOVA complements NEAR’s AI-focused tools:
- **TEEs**: Secures data at rest/transit for confidential compute (e.g., private AI inference in Phala enclaves).
- **Intents**: Gates solver access to encrypted payloads, enabling private, AI-driven fulfillment (e.g., cross-chain swaps).
- **Shade Agents**: Persists off-chain data for autonomous workers, resolving the "oracle problem" with verified inputs (e.g., prediction markets).

## Integration Options

Choose the integration that best fits your use case:

### 🤖 MCP Server - AI Assistant Integration

For AI-assisted workflows using Claude or other MCP-compatible assistants.

```bash
pip install nova-mcp-server
```

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
nova-sdk-rs = "0.1.0"
```

**Best for**: Smart contracts, CLI tools, high-performance services, native applications

**Documentation**: [/nova-sdk-rs](./nova-sdk-rs) | [GitBook](https://nova-25.gitbook.io/nova-docs/)

---

## Quick Start Examples

### MCP Server (Natural Language)
```
You: "Create a group called 'research_team' and upload this data securely"
Claude: [uses NOVA MCP tools to encrypt, upload to IPFS, and record on NEAR]
```

### JavaScript SDK
```typescript
import { NovaSdk } from 'nova-sdk-js';

const sdk = new NovaSdk(rpcUrl, contractId, pinataKey, pinataSecret);
await sdk.withSigner(privateKey, accountId);

const result = await sdk.compositeUpload(
  'my_group', 'user.testnet', fileData, 'data.txt'
);
console.log('Uploaded:', result.cid);
```

### Rust SDK
```rust
use nova_sdk_rs::NovaSdk;

let sdk = NovaSdk::new(rpc_url, contract_id, pinata_key, pinata_secret)
    .with_signer(private_key, account_id)?;

let result = sdk.composite_upload(
    "my_group", "user.testnet", "data", "file.txt"
).await?;
println!("Uploaded: {}", result.cid);
```

## Architecture

```
┌─────────────────┐
│   Your dApp     │
│  (MCP/JS/Rust)  │
└────────┬────────┘
         │
    ┌────┴────┐
    │  NOVA   │
    │   SDK   │
    └────┬────┘
         │
    ┌────┴─────────────┐
    │                  │
┌───▼────┐      ┌─────▼─────┐
│  IPFS  │      │   NEAR    │
│(Pinata)│      │ Blockchain│
└────────┘      └───────────┘
 Encrypted       Access Control
   Storage        & Metadata
```

1. **Client-Side Encryption**: Files encrypted locally before upload
2. **IPFS Storage**: Encrypted files stored on decentralized IPFS
3. **NEAR Blockchain**: Access control groups and transaction logs
4. **Key Management**: Group keys stored on-chain, encrypted per member

## Use Cases

### 🤖 AI & Machine Learning
- **Dataset Sharing**: Securely share training data between researchers
- **Model Fine-Tuning**: Store and access sensitive data for AI agent training
- **TEE Integration**: Provide encrypted inputs to confidential compute environments

### 🏢 Enterprise & Collaboration
- **Document Sharing**: Secure file sharing within organizations
- **Access Revocation**: Remove member access and rotate keys automatically
- **Audit Trails**: Immutable transaction logs on NEAR blockchain

### 🔐 Privacy-Preserving Applications
- **Healthcare Records**: HIPAA-compliant data sharing
- **Financial Data**: Secure transmission of sensitive financial information
- **Identity Documents**: User-controlled identity verification data

## NEAR Token Requirements

Operations require small NEAR token deposits for storage:

- Register group: ~0.1 NEAR
- Add member: ~0.0005 NEAR
- Revoke member: ~0.0005 NEAR
- Store key: ~0.0005 NEAR
- Record transaction: ~0.002 NEAR

Ensure your NEAR account has sufficient balance before operations.

## Documentation

Comprehensive documentation is available on GitBook:

📚 **[NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)**

### Quick Links
- [Quick Start Examples](https://nova-25.gitbook.io/nova-docs#quick-start-examples)
- [MCP Server Guide](https://nova-25.gitbook.io/nova-docs/mcp-server)
- [JavaScript SDK Reference](https://nova-25.gitbook.io/nova-docs/nova-sdk-js)
- [Rust SDK Reference](https://nova-25.gitbook.io/nova-docs/nova-sdk-rs)
- [Architecture & Concepts](https://nova-25.gitbook.io/nova-docs#architecture)

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Never commit NEAR private keys to version control
2. **Key Storage** - Store encryption keys securely using proper key management
3. **IPFS Privacy** - IPFS content is addressable by CID; encryption is essential
4. **Access Control** - Always verify user authorization before operations
5. **Key Rotation** - Revoked members cannot decrypt content uploaded after revocation
6. **Client-Side Encryption** - Files are encrypted locally, never exposing plaintext to IPFS

## Future Roadmap

### Potential SDK Enhancements
- **Pay-per-Action Model**: Add fees to `#[payable]` methods, setup fees to `nova-sdk.near`
- **Agent Permissions**: Extend file upload through `record_transaction` to agents/members (currently owner-only).
- **Transaction Listing**: Extend `get_transactions_for_group` calls to agents/members (currently owner-only).
- **Member Discovery**: Extend `group_members` view to agents/members (currently owner-only).
- **Token-Gated Access**: Reinforce access control with NFT/token holdings (Access Token NFTs)?
- **AI Metadata Extraction**: Automate metadata extraction with AI for optimized IPFS indexing.
- **Dataset Monetization**: Add pricing to file upload so file owners can monetize dataset access.
- **Multi-Party Upload**: So far all members can upload, but a contract update (New method: grant_publish_rights(group_id: String, user_id: AccountId, can_publish: bool))could add per-member publish rights. 
- **Group creation access**: So far only contract owner can create groups. in this scenario people who want to create groups should deploy their own contract. Shall I allow anyone to create groups on this contract?

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
- [Create NEAR Account](https://testnet.mynearwallet.com/)

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

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

Built with ❤️ for the NEAR ecosystem, leveraging:
- NEAR Protocol for decentralized access control
- IPFS/Pinata for decentralized storage
- Model Context Protocol for AI integration

---

**Ready to build privacy-first dApps?** Choose your integration: [MCP](./mcp-server) | [JavaScript](./nova-sdk-js) | [Rust](./nova-sdk-rs)

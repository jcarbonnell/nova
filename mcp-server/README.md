# NOVA MCP Server

A Model Context Protocol (MCP) server for NOVA secure file-sharing on NEAR blockchain. Enables AI assistants like Claude to interact with encrypted, decentralized file storage through natural language, providing seamless group-based access control, IPFS persistence, and TEE-secured keys via Shade Agents.

## Features

- 🤖 **AI-Native Integration** - Natural language interface for encrypted file operations
- 🔐 **AES-256-CBC Encryption** - Client-side encryption exposed through MCP tools
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and access control
- 👥 **Group Management** - Fine-grained access control with member authorization
- 🔑 **TEE-Secured Keys** - Off-chain key storage in Shade Agents (Phala TEEs) with ed25519 token auth
- 🔄 **Key Rotation** - Automatic key rotation on member revocation via Shade events
- 🚀 **Composite Operations** - High-level workflows for upload/retrieve
- 💬 **Conversational** - Natural language commands for all NOVA operations

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard that enables AI assistants to securely connect with external tools and data sources. MCP servers expose capabilities that AI models can use to perform actions on behalf of users.

NOVA's MCP server allows AI assistants to:
- Encrypt and upload files to IPFS
- Retrieve and decrypt files from IPFS
- Manage blockchain-based access control groups
- Record and query file transactions on NEAR
- Fetch ephemeral keys from TEE-secured Shade Agents

## Installation

### Prerequisites

- Python 3.10+
- NEAR testnet account ([create one](https://testnet.mynearwallet.com/))
- Pinata API credentials ([sign up](https://pinata.cloud))
- Shade Agent API URL (from [Phala cloud](https://cloud.phala.network/))

### Install from PyPI (upcoming)

```bash
pip install nova-mcp-server
```

### Install from Source

```bash
git clone https://github.com/jcarbonnell/nova.git
cd nova/mcp-server
pip install -e .
```

## Configuration

### Environment Variables

Create a `.env` file or set environment variables:

```bash
# NEAR Configuration
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_CONTRACT_ID=nova-contract.testnet
NEAR_ACCOUNT_ID=your-account.testnet
NEAR_PRIVATE_KEY=ed25519:your_private_key

# Pinata Configuration
PINATA_API_KEY=your_pinata_api_key
PINATA_SECRET_KEY=your_pinata_secret_key
```

### Claude Desktop Integration

Add to your Claude Desktop config file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nova": {
      "command": "python",
      "args": ["-m", "nova_mcp_server"],
      "env": {
        "NEAR_RPC_URL": "https://rpc.testnet.near.org",
        "NEAR_CONTRACT_ID": "nova-contract.testnet",
        "NEAR_ACCOUNT_ID": "your-account.testnet",
        "NEAR_PRIVATE_KEY": "ed25519:your_private_key",
        "PINATA_API_KEY": "your_pinata_key",
        "PINATA_SECRET_KEY": "your_pinata_secret"
      }
    }
  }
}
```

After updating the config, restart Claude Desktop.

## Quick Start

Once configured, interact with NOVA through natural language in Claude:

```
You: "Create a new group called 'research_team' and add bob.testnet as a member"

Claude: [uses register_group and add_group_member tools]
✅ Group 'research_team' created
✅ Added bob.testnet to the group

You: "Upload this research data to the research_team group"
[attach file or provide data]

Claude: [uses composite_upload tool]
✅ File encrypted and uploaded to IPFS: QmXxX...
📝 Transaction recorded: ABC123...
🔒 File hash: sha256:def456...

You: "Is alice.testnet authorized to access research_team?"

Claude: [uses auth_status tool]
❌ alice.testnet is not currently authorized for research_team
```

## Available Tools

The MCP server exposes 11 tools for AI assistants:

### File Operations

- **`composite_upload`** - Encrypt file (using Shade key), upload to IPFS, record transaction
  ```
  Parameters: group_id, user_id, data, filename
  Returns: cid, trans_id, file_hash
  ```

- **`composite_retrieve`** - Fetch from IPFS and decrypt (using Shade key)
  ```
  Parameters: group_id, ipfs_hash
  Returns: decrypted_b64, file_hash
  ```

- **`ipfs_upload`** - Upload encrypted data to IPFS
- **`ipfs_retrieve`** - Retrieve data from IPFS

### Encryption

- **`encrypt_data`** - AES-256-CBC encryption
- **`decrypt_data`** - AES-256-CBC decryption

### Group Management

- **`register_group`** - Create new access control group (auto-generates Shade key)
- **`add_group_member`** - Grant member access
- **`revoke_group_member`** - Revoke access and rotate Shade key
- **`auth_status`** - Check user authorization

### Key Management

- **`get_shade_key`** - Retrieve ephemeral key from TEE-secured Shade Agent (token-gated)


### Transaction Recording

- **`record_near_transaction`** - Log file metadata on NEAR

## Usage Examples

### Example 1: Secure File Sharing

```
You: "I need to share a confidential document with my team. 
     Create a group called 'project_alpha' and upload this file securely."

Claude: I'll help you set up secure file sharing:
1. Creating group 'project_alpha' (TEE key generated)...
2. Encrypting and uploading your document (using Shade key)...

[uses register_group, then composite_upload]

✅ Done! Your document is encrypted and stored at IPFS hash: QmABC...
The transaction is recorded on NEAR blockchain.

Would you like to add team members to the group?
```

### Example 2: Access Control

```
You: "Add carol.testnet and dave.testnet to project_alpha, 
     then remove bob.testnet"

Claude: [uses add_group_member twice, then revoke_group_member]

✅ Added carol.testnet to project_alpha
✅ Added dave.testnet to project_alpha
✅ Revoked bob.testnet and rotated TEE key

Bob can no longer access any new files shared in this group.
```

### Example 3: File Retrieval

```
You: "Retrieve the file at QmABC... from project_alpha and show me its contents"

Claude: [uses composite_retrieve with Shade key]

📄 Retrieved and decrypted file:
[displays file contents]

🔒 Verified file hash matches: sha256:xyz789...
```

### Example 4: High-Value Data Workflow

```
You: "I have sensitive AI training data. Create a group called 'ai_collab' and upload this dataset securely."

Claude: I'll set up secure sharing for your AI dataset:
1. Creating group 'ai_collab' (TEE key generated in Shade Agent)...
2. Fetching ephemeral Shade key (token-signed and attested)...
3. Encrypting dataset with TEE key and uploading to IPFS...

[uses register_group, then composite_upload with get_shade_key]

✅ Done! Your dataset is encrypted and stored at IPFS hash: QmHighValue...
📝 Transaction recorded: DEF456...
🔒 File hash: sha256:ghi789... (verified)

You: "Share access with partner.eth for collaboration."

Claude: [uses add_group_member]

✅ Added partner.eth to 'ai_collab' group
Partner can now retrieve via their own token (TEE-verified access).

You: "Show me the dataset contents to verify."

Claude: Fetching via partner token for verification...
[uses composite_retrieve with get_shade_key]

📄 Retrieved and decrypted dataset preview:
[displays sample data rows/embeddings]

✅ Access confirmed—full dataset available securely.

You: "The collaboration is over; revoke partner.eth access."

Claude: [uses revoke_group_member]

✅ Revoked partner.eth from 'ai_collab'
🔄 TEE key rotated in Shade Agent—old tokens invalid, future files locked to partner.

Partner cannot access new uploads, and old files remain encrypted.
```

## Core Concepts

### Groups

Groups provide isolated access control domains. Each group has:
- A unique identifier (`group_id`)
- An owner (NEAR account) who manages membership
- A TEE-secured encryption key (generated/rotated in Shade Agent)
- A list of authorized members

### Encryption Flow

1. **Upload**: Fetch ephemeral Shade key (token-gated) → Encrypt locally → Upload to IPFS → Record transaction
2. **Download**: Fetch ephemeral Shade key → Fetch from IPFS → Decrypt locally

### Access Control

- Only group owners can add/revoke members
- Keys retrieved via signed tokens (ed25519, nonce/timestamp-gated) from TEE
- Member revocation triggers automatic TEE key rotation
- All operations logged on NEAR blockchain; Shade attestations verified on-chain

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Store NEAR private keys securely; never commit to version control
2. **TEE Keys** - Encryption keys stored encrypted in Shade TEEs—never on-chain; access via attested tokens only
3. **IPFS Privacy** - IPFS content is public by CID; encryption + TEE gating essential
4. **Key Rotation** - Revoked members cannot decrypt files uploaded after revocation (TEE swap)
5. **Local Decryption** - Files are decrypted client-side; tokens expire post-use (replay-proof)
6. **Attestation** - Shade checksums verified on-chain—ensures TEE integrity


## NEAR Token Deposits

Some operations require NEAR token deposits for storage:

- `register_group` - ~0.1 NEAR (includes Shade init)
- `add_group_member` - ~0.0005 NEAR
- `revoke_group_member` - ~0.0005 NEAR  (includes Shade rotate)
- `claim_token` (internal) - ~0.001 NEAR
- `record_transaction` - ~0.002 NEAR

Ensure your NEAR account has sufficient balance.

## Development

### Running Tests

```bash
# Install development dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run with coverage
pytest --cov=nova_mcp_server
```

### Building from Source

```bash
# Clone repository
git clone https://github.com/jcarbonnell/nova.git
cd nova/mcp-server

# Install dependencies
pip install -r requirements.txt

# Run MCP server
python -m nova_mcp_server
```

### MCP Inspector

Test the MCP server using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector python -m nova_mcp_server
```

## Comparison with SDKs

| Feature | MCP Server | JavaScript SDK | Rust SDK |
|---------|-----------|----------------|----------|
| **Interface** | Natural language | Programmatic API | Programmatic API |
| **Use Case** | AI assistants | Web/Node.js apps | System apps, smart contracts |
| **Installation** | `pip install` | `npm install` | `cargo add` |
| **Encryption** | Automatic | Manual control | Manual control |
| **Integration** | Claude Desktop | Any JS runtime | Any Rust project |

Choose MCP for AI-assisted workflows, JS SDK for web applications, or Rust SDK for high-performance system integration.

## Troubleshooting

### MCP Server Not Connecting

1. Check Claude Desktop config path is correct
2. Verify all environment variables are set (incl. SHADE_API_URL)
3. Restart Claude Desktop after config changes
4. Check logs: `~/Library/Logs/Claude/mcp-*.log` (MacOS)

### NEAR Transaction Failures

1. Verify account has sufficient balance: `near state your-account.testnet`
2. Check private key format: `ed25519:base58_encoded_key`
3. Ensure contract ID is correct for network (testnet/mainnet)

### Shade/TEE Issues

1. Verify SHADE_API_URL reachable (e.g., curl {SHADE_API_URL}/api/key-management/get_key)
2. Check checksum mismatches: Ensure update_checksum called post-gen
3. Token errors: Validate timestamp/nonce in payload; refresh if expired

### IPFS Upload Failures

1. Verify Pinata API credentials are correct
2. Check file size limits (100MB default on free tier)
3. Ensure stable internet connection

## Resources

- [NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Claude Desktop MCP Guide](https://docs.anthropic.com/claude/docs/model-context-protocol)
- [NEAR Protocol](https://near.org)
- [Shade Agents](https://docs.near.org/ai/introduction)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`pytest`)
5. Submit a pull request

## License

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/LICENSE) file for details.
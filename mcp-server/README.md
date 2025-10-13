# NOVA MCP Server

A Model Context Protocol (MCP) server for NOVA secure file-sharing on NEAR blockchain. Enables AI assistants like Claude to interact with encrypted, decentralized file storage through natural language, providing seamless group-based access control and IPFS persistence.

## Features

- 🤖 **AI-Native Integration** - Natural language interface for encrypted file operations
- 🔐 **AES-256-CBC Encryption** - Client-side encryption exposed through MCP tools
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and access control
- 👥 **Group Management** - Fine-grained access control with member authorization
- 🔑 **Key Rotation** - Automatic key rotation on member revocation
- 🚀 **Composite Operations** - High-level workflows for upload/retrieve
- 💬 **Conversational** - Natural language commands for all NOVA operations

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io) is an open standard that enables AI assistants to securely connect with external tools and data sources. MCP servers expose capabilities that AI models can use to perform actions on behalf of users.

NOVA's MCP server allows AI assistants to:
- Encrypt and upload files to IPFS
- Retrieve and decrypt files from IPFS
- Manage blockchain-based access control groups
- Record and query file transactions on NEAR

## Installation

### Prerequisites

- Python 3.10+
- NEAR testnet account ([create one](https://testnet.mynearwallet.com/))
- Pinata API credentials ([sign up](https://pinata.cloud))

### Install from PyPI

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

The MCP server exposes 13 tools for AI assistants:

### File Operations

- **`composite_upload`** - Encrypt file, upload to IPFS, record transaction
  ```
  Parameters: group_id, user_id, data, filename
  Returns: cid, trans_id, file_hash
  ```

- **`composite_retrieve`** - Fetch from IPFS and decrypt
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

- **`register_group`** - Create new access control group
- **`add_group_member`** - Grant member access
- **`revoke_group_member`** - Revoke access and rotate key
- **`auth_status`** - Check user authorization

### Key Management

- **`store_group_key`** - Store encryption key on blockchain
- **`get_group_key`** - Retrieve key for authorized users

### Transaction Recording

- **`record_near_transaction`** - Log file metadata on NEAR

## Usage Examples

### Example 1: Secure File Sharing

```
You: "I need to share a confidential document with my team. 
     Create a group called 'project_alpha' and upload this file securely."

Claude: I'll help you set up secure file sharing:
1. Creating group 'project_alpha'...
2. Encrypting and uploading your document...

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
✅ Revoked bob.testnet and rotated encryption key

Bob can no longer access any new files shared in this group.
```

### Example 3: File Retrieval

```
You: "Retrieve the file at QmABC... from project_alpha and show me its contents"

Claude: [uses composite_retrieve]

📄 Retrieved and decrypted file:
[displays file contents]

🔒 Verified file hash matches: sha256:xyz789...
```

## Core Concepts

### Groups

Groups provide isolated access control domains. Each group has:
- A unique identifier (`group_id`)
- An owner (NEAR account) who manages membership
- A shared encryption key stored on blockchain
- A list of authorized members

### Encryption Flow

1. **Upload**: Get group key → Encrypt locally → Upload to IPFS → Record transaction
2. **Download**: Get group key → Fetch from IPFS → Decrypt locally

### Access Control

- Only group owners can add/revoke members
- Only authorized members can retrieve group keys
- Member revocation triggers automatic key rotation
- All operations logged on NEAR blockchain

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Store NEAR private keys securely; never commit to version control
2. **Group Keys** - Encryption keys are stored on blockchain, encrypted per member
3. **IPFS Privacy** - IPFS content is public by CID; encryption is essential
4. **Key Rotation** - Revoked members cannot decrypt files uploaded after revocation
5. **Local Decryption** - Files are decrypted client-side, never exposing plaintext to IPFS

## NEAR Token Deposits

Some operations require NEAR token deposits for storage:

- `register_group` - ~0.1 NEAR
- `add_group_member` - ~0.0005 NEAR
- `revoke_group_member` - ~0.0005 NEAR
- `store_group_key` - ~0.0005 NEAR
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
2. Verify all environment variables are set
3. Restart Claude Desktop after config changes
4. Check logs: `~/Library/Logs/Claude/mcp-*.log` (MacOS)

### NEAR Transaction Failures

1. Verify account has sufficient balance: `near state your-account.testnet`
2. Check private key format: `ed25519:base58_encoded_key`
3. Ensure contract ID is correct for network (testnet/mainnet)

### IPFS Upload Failures

1. Verify Pinata API credentials are correct
2. Check file size limits (100MB default on free tier)
3. Ensure stable internet connection

## Resources

- [NOVA Documentation](https://nova-docs.gitbook.io)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Claude Desktop MCP Guide](https://docs.anthropic.com/claude/docs/model-context-protocol)
- [NEAR Protocol](https://near.org)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
- MCP Support: [MCP Discord](https://discord.gg/modelcontextprotocol)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`pytest`)
5. Submit a pull request

## License

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/nova/blob/main/mcp-server/LICENSE) file for details.
# NOVA SDK for JavaScript/TypeScript

**Version:** 1.1.0
**License:** MIT  
**Network:** NEAR Protocol (Mainnet & Testnet)
**Package:** [nova-sdk-js](https://www.npmjs.com/package/nova-sdk-js)

A JavaScript/TypeScript SDK for NOVA's secure, decentralized file-sharing primitive on NEAR. NOVA hybridizes on-chain access control with off-chain TEE-secured keys via Shade Agents, using nonce-based ed25519-signed tokens for ephemeral, verifiable access. This ensures privacy-first data sharing for AI datasets, healthcare/financial records, and sensitive documents.

## Features

- 🔐 **Zero-Knowledge Architecture** - Keys managed in TEE; never exposed to SDK
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable access control & transaction logs
- 🛡️ **API Key Auth** - Secure authentication via API keys (get yours at nova-sdk.com)
- 🔑 **Automated Signing** - MCP server signs transactions using keys from Shade TEE
- 👥 **Group Management** - Fine-grained membership with automatic key rotation on revocation
- 🚀 **Composite Operations** - Simplified workflows for upload/retrieve
- 📦 **TypeScript Support** - Full type definitions included

## Installation

```bash
npm install nova-sdk-js
```

## ⚠️ Mainnet Notice

**NOVA SDK operates on NEAR mainnet by default.** All operations consume real NEAR tokens.

Typical costs (mainnet):
- **Register group**: ~0.05 NEAR (~$0.15 USD)
- **Upload file**: ~0.01 NEAR (incl. IPFS storage)
- **Retrieve file**: ~0.001 NEAR

```typescript
const sdk = new NovaSdk('yourname.nova-sdk-6.testnet', {
  apiKey: process.env.NOVA_API_KEY,
  rpcUrl: 'https://rpc.testnet.near.org',
  contractId: 'nova-sdk-6.testnet',
});
```

> **Note:** On testnet, IPFS operations are mocked (in-memory storage). Blockchain operations use real testnet with faucet tokens.

## Quick Start

### Prerequisites

1. **Create a NOVA account** at [nova-sdk.com](https://nova-sdk.com)
2. **Generate an API key** from the "Manage Account" menu
3. **Fund your account** with NEAR tokens for transaction fees

### Simple upload/retrieve example
```typescript
import { NovaSdk } from 'nova-sdk-js';

// Initialize with your account ID and API key
const sdk = new NovaSdk('alice.nova-sdk.near', {
  apiKey: process.env.NOVA_API_KEY
});

// Register group (you become owner)
await sdk.registerGroup('confidential-docs');

// Upload a file
const result = await sdk.upload('my-group', Buffer.from('Hello NOVA!'), 'hello.txt');
console.log('Uploaded:', result.cid);

// Retrieve the file
const { data } = await sdk.retrieve('my-group', result.cid);
console.log('Retrieved:', data.toString());
```

That's it! The SDK automatically:
- Authenticates using your API key
- Manages session tokens (auto-refresh before 24h expiry)
- Handles all encryption/decryption client-side

## Configuration Options
```typescript
// Standard usage (mainnet)
const sdk = new NovaSdk('alice.nova-sdk.near', {
  apiKey: process.env.NOVA_API_KEY  // Required: get yours at nova-sdk.com
});

// Testnet configuration
const sdk = new NovaSdk('alice.nova-sdk-6.testnet', {
  apiKey: process.env.NOVA_API_KEY,
  rpcUrl: 'https://rpc.testnet.near.org',
  contractId: 'nova-sdk-6.testnet',
});

// Custom MCP server (advanced)
const sdk = new NovaSdk('alice.nova-sdk.near', {
  apiKey: process.env.NOVA_API_KEY,
  mcpUrl: 'https://your-mcp-server.com',
  authUrl: 'https://your-auth-server.com',
});
```


## 📖 Core Operations

### File Upload & Retrieve
```typescript
import fs from 'fs';

// Upload (encrypts client-side, stores on IPFS, records on NEAR)
const fileData = fs.readFileSync('./document.pdf');
const result = await sdk.upload('my-group', fileData, 'document.pdf');

console.log('CID:', result.cid);           // IPFS content ID
console.log('TX:', result.trans_id);       // NEAR transaction ID
console.log('Hash:', result.file_hash);    // SHA-256 of plaintext

// Retrieve (fetches from IPFS, decrypts client-side)
const { data } = await sdk.retrieve('my-group', result.cid);
fs.writeFileSync('./downloaded.pdf', data);
```

### Group Management
```typescript
// Create a group (you become owner)
await sdk.registerGroup('team-files');

// Add members
await sdk.addGroupMember('team-files', 'bob.nova-sdk.near');
await sdk.addGroupMember('team-files', 'carol.nova-sdk.near');

// Check authorization
const isAuthorized = await sdk.isAuthorized('team-files', 'bob.nova-sdk.near');

// Revoke access (triggers automatic key rotation)
await sdk.revokeGroupMember('team-files', 'bob.nova-sdk.near');

// Self-join an OPEN group (hackathon submission groups the organizer has opened).
// Idempotent: safe to call again if already a member.
await sdk.joinGroup('hackathon-group-id');
```

### Read-Only Queries

These don't require authentication:
```typescript
// Account balance
const balance = await sdk.getBalance();

// Group info
const owner = await sdk.getGroupOwner('team-files');
const checksum = await sdk.getGroupChecksum('team-files');

// Transaction history
const transactions = await sdk.getTransactionsForGroup('team-files');

// Fee estimation
const fee = await sdk.estimateFee('register_group');
```

## How It Works

### Upload Flow
```
1. SDK calls prepare_upload → MCP returns encryption key from TEE
2. SDK encrypts file locally (AES-256-GCM)
3. SDK calls finalize_upload with encrypted data
4. MCP uploads to IPFS and records on NEAR
5. Returns: { cid, trans_id, file_hash }
```

### Retrieve Flow
```
1. SDK calls prepare_retrieve → MCP returns key + encrypted data
2. SDK decrypts locally (AES-256-GCM)
3. Returns: { data, ipfs_hash, group_id }
```

**Key point:** Plaintext data and encryption keys never travel together. The MCP server never sees your unencrypted files.

## Authentication

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
```typescript
// Use environment variables
const sdk = new NovaSdk(process.env.NOVA_ACCOUNT_ID, {
  apiKey: process.env.NOVA_API_KEY
});

// Force refresh session token
await sdk.refreshToken();

// Get network info
const info = sdk.getNetworkInfo();
```

**Note:** One API key per account. Viewing/generating your key returns the current key; use **Rotate** at nova-sdk.com to issue a fresh key and permanently invalidate the old one.

### How Authentication Works

Under the hood, API keys are used to generate session tokens:
1. SDK sends API key to `/api/auth/session-token`
2. Server validates key and returns JWT (24h expiry)
3. SDK uses JWT for all MCP operations
4. Auto-refresh happens before expiry

Session tokens contain:
- `account_id`: Your NOVA account
- `sub`: Your Auth0 subject ID
- `aud`: MCP server URL (port 8000)
- `exp`: Expiration timestamp (24h)

## Error Handling

```typescript
import { NovaSdk, NovaError } from 'nova-sdk-js';

try {
  await sdk.upload('my-group', data, 'file.txt');
} catch (e) {
  if (e instanceof NovaError) {
    if (e.message.includes('Audience')) {
      console.error('Token validation failed - try refreshing: await sdk.refreshToken()');
    } else if (e.message.includes('not found')) {
      console.error('Account not found - create one at nova-sdk.com');
    } else if (e.message.includes('not authorized')) {
      console.error('Not a member of this group');
    } else if (e.message.includes('Insufficient')) {
      console.error('Need more NEAR - deposit at nova-sdk.com');
    } else {
      console.error('NOVA error:', e.message);
    }
  }
}
```

## Costs (Mainnet)

Some operations require NEAR token deposits (paid from user's NOVA account):

- `registerGroup()` - ~0.05 NEAR
- `addGroupMember()` - ~0.001 NEAR
- `revokeGroupMember()` - ~0.001 NEAR
- `upload()` - ~0.003 NEAR (claim token + record Tx)
- `retrieve()` - 0.001 NEAR (claim only)

Ensure your NOVA account has sufficient balance before calling these methods.

## API Reference

### Constructor
```typescript
new NovaSdk(accountId: string, config?: NovaSdkConfig)
```

### Methods

| Method | Description |
|--------|-------------|
| `upload(groupId, data, filename)` | Upload encrypted file |
| `retrieve(groupId, cid)` | Retrieve and decrypt file |
| `registerGroup(groupId)` | Create new group |
| `addGroupMember(groupId, memberId)` | Add member to group (owner only) |
| `joinGroup(groupId)` | Self-join an open group (e.g. hackathon submission groups) |
| `revokeGroupMember(groupId, memberId)` | Remove member (rotates key) |
| `authStatus(groupId?)` | Check authentication status |
| `isAuthorized(groupId, userId?)` | Check group authorization |
| `getGroupOwner(groupId)` | Get group owner |
| `getGroupChecksum(groupId)` | Get TEE attestation checksum |
| `getTransactionsForGroup(groupId)` | List group transactions |
| `getBalance(accountId?)` | Get NEAR balance |
| `estimateFee(action)` | Estimate operation cost |
| `refreshToken()` | Force token refresh |
| `computeHash(data)` | SHA-256 hash (sync) |
| `computeHashAsync(data)` | SHA-256 hash (async) |

## License

MIT [LICENSE](LICENSE) - Copyright (c) 2026 CivicTech OÜ

## Resources

- [NOVA Documentation](https://nova-25.gitbook.io/nova-docs/)
- [NEAR Protocol](https://near.org)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)
- [Phala TEE](https://phala.com/)
- [NEAR JavaScript API](https://docs.near.org/tools/near-api-js/quick-reference)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
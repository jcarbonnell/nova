# NOVA SDK for JavaScript/TypeScript

**Version:** 1.0.1 (Mainnet)  
**License:** MIT  
**Network:** NEAR Protocol Mainnet
**Package:** [nova-sdk-js](https://www.npmjs.com/package/nova-sdk-js)

A JavaScript/TypeScript SDK for NOVA's secure, decentralized file-sharing primitive on NEAR. NOVA hybridizes on-chain access control with off-chain TEE-secured keys via Shade Agents, using nonce-based ed25519-signed tokens for ephemeral, verifiable access. This ensures privacy-first data sharing for AI datasets, healthcare/financial records, and sensitive documents.


## Features

- 🔐 **Zero-Knowledge Architecture** - Keys managed in TEE; never exposed to SDK
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable access control & transaction logs
- 🛡️ **Session-Based Auth** - OAuth flow (no private key handling)
- 🔑 **Automated Signing** - MCP server signs transactions using keys from Shade TEE
- 👥 **Group Management** - Fine-grained membership with automatic key rotation on revocation
- 🚀 **Composite Operations** - Simplified workflows for upload/retrieve
- 📦 **TypeScript Support** - Full type definitions included

## Installation

```bash
npm install nova-sdk-js
```

## ⚠️ Mainnet Notice

**NOVA v1.0.1 operates on NEAR mainnet by default.** All operations consume real NEAR tokens.

Typical costs (mainnet):
- **Register group**: ~0.05 NEAR (~$0.15 USD)
- **Upload file**: ~0.01 NEAR (incl. IPFS storage)
- **Retrieve file**: ~0.001 NEAR

**For development, use testnet**

## Quick Start

### 1. Get Your Credentials

Visit **[nova-sdk.com](https://nova-sdk.com)** to:
1. Login with email or social (Google/Apple/GitHub)
2. Your NEAR account is created automatically (e.g., `alice.nova-sdk.near`)
3. Get your session token at `/api/auth/session-token`

### 2. Initialize SDK
```typescript
import { NovaSdk } from 'nova-sdk-js';

const sdk = new NovaSdk('alice.nova-sdk.near', {
  sessionToken: process.env.NOVA_SESSION_TOKEN!,  // JWT from nova-sdk.com
});

// Verify network
console.log(sdk.getNetworkInfo());
// { networkId: 'mainnet', contractId: 'nova-sdk.near', ... }
```

### 3. Upload & Retrieve Files
```typescript
import fs from 'fs';

// Register group (you become owner)
await sdk.registerGroup('confidential-docs');

// Upload encrypted file
const fileData = fs.readFileSync('./report.pdf');
const result = await sdk.upload(
  'confidential-docs',  // group_id
  fileData,             // Buffer
  'report.pdf'          // filename
);

console.log('✅ Uploaded!');
console.log('📦 IPFS CID:', result.cid);
console.log('🔗 Transaction:', result.trans_id);
console.log('#️⃣ File Hash:', result.file_hash);

// Retrieve file
const { data, ipfs_hash, group_id } = await sdk.retrieve(
  'confidential-docs',
  result.cid
);

fs.writeFileSync('./decrypted-report.pdf', data);
console.log('✅ File retrieved from group:', group_id);
```

## 📖 Core Operations

### Group Management
```typescript
// Register new group (caller becomes owner)
await sdk.registerGroup('research-team');

// Add members
await sdk.addGroupMember('research-team', 'bob.nova-sdk.near');

// Check authorization
const authorized = await sdk.isAuthorized('research-team');
console.log('Authorized:', authorized);

// Get auth status with details
const status = await sdk.authStatus('research-team');
console.log('Status:', status);
// { authenticated: true, near_account_id: 'alice.nova-sdk.near', authorized_for_group: true }

// Revoke member (triggers automatic key rotation in TEE)
await sdk.revokeGroupMember('research-team', 'bob.nova-sdk.near');
```

### File Operations
```typescript
// Upload encrypted file (encryption happens client-side)
const uploadResult = await sdk.upload(
  'group-id',
  fileBuffer,
  'filename.ext'
);
// Returns: { cid, trans_id, file_hash }

// Retrieve and decrypt file (decryption happens client-side)
const retrieveResult = await sdk.retrieve(
  'group-id',
  'QmXYZ...'  // IPFS CID
);
// Returns: { data, ipfs_hash, group_id }
```

### Read-Only Queries

These methods use direct RPC calls (no MCP authentication needed):
```typescript
// Check account balance
const balance = await sdk.getBalance();
console.log('Balance:', balance, 'yoctoNEAR');

// Get group owner
const owner = await sdk.getGroupOwner('research-team');

// Get group checksum (TEE attestation)
const checksum = await sdk.getGroupChecksum('research-team');

// Estimate fees
const fee = await sdk.estimateFee('register_group');
console.log('Fee:', fee, 'yoctoNEAR');

// List group transactions
const txs = await sdk.getTransactionsForGroup('research-team');
txs.forEach(tx => {
  console.log('File:', tx.file_hash, '| IPFS:', tx.ipfs_hash);
});

// Compute file hash (utility - async for browser compatibility)
const hash = await sdk.computeHashAsync(Buffer.from('data'));
// Or synchronous (Node.js only):
const hashSync = sdk.computeHash(Buffer.from('data'));
```

## Configuration

### Mainnet (Default)
```typescript
const sdk = new NovaSdk('alice.nova-sdk.near', {
  sessionToken: process.env.NOVA_SESSION_TOKEN!,
  // Optional overrides (rarely needed):
  // rpcUrl: 'https://rpc.mainnet.near.org',
  // contractId: 'nova-sdk.near',
  // mcpUrl: 'https://nova-mcp.fastmcp.app',
});
```

### Testnet (Development)
```typescript
const sdk = new NovaSdk('alice.nova-sdk-5.testnet', {
  sessionToken: process.env.TESTNET_SESSION_TOKEN!,
  rpcUrl: 'https://rpc.testnet.near.org',
  contractId: 'nova-sdk-5.testnet',
});

// SDK auto-detects testnet (no mainnet warnings)
console.log(sdk.getNetworkInfo().networkId);  // 'testnet'
```

## 🔐 Security Model

### How Authentication Works

1. **User logs in** via OAuth at nova-sdk.com (Auth0)
2. **Frontend receives JWT** with user's email + NEAR account ID
3. **SDK sends JWT** with every request to MCP server
4. **MCP verifies JWT** and retrieves user's credentials from Shade Agent (TEE)
5. **MCP signs transactions** via NEAR Meta Relayer (chain signatures)
6. **Keys never leave TEE** - SDK only holds session token

### Why This Is Secure

- ✅ **No private keys in SDK** - only session tokens (JWTs)
- ✅ **Keys encrypted in TEE** - hardware-isolated Shade Agent
- ✅ **Session tokens expire** - refresh every 24 hours
- ✅ **Automatic key rotation** - on member revocation
- ✅ **TEE attestation** - cryptographic proof of genuine hardware

---

## 🔒 Client-Side Encryption

NOVA v1.1.0 performs all encryption and decryption client-side using AES-256-GCM:

1. **Upload flow:**
   - SDK calls `prepare_upload` → receives encryption key from TEE
   - SDK encrypts data locally with AES-256-GCM
   - SDK calls `finalize_upload` with encrypted data
   - Key never travels with encrypted data

2. **Retrieve flow:**
   - SDK calls `prepare_retrieve` → receives key + encrypted data
   - SDK decrypts data locally
   - Plaintext never exists on server

This ensures **true end-to-end encryption** - the MCP server never sees plaintext data.

---

## 🔄 Session Token Management

### Getting a Token
```bash
# After logging in at nova-sdk.com
curl https://nova-sdk.com/api/auth/session-token \
  -H "Cookie: appSession=..." \
  -X POST

# Response: { "token": "eyJhbG...", "account_id": "alice.nova-sdk.near" }
```

### Refreshing Tokens

Session tokens expire after 24 hours. Refresh by calling the session-token endpoint again:

```typescript
async function refreshToken(): Promise {
  const response = await fetch('https://nova-sdk.com/api/auth/session-token', {
    method: 'POST',
    credentials: 'include',  // Include cookies
  });
  
  if (!response.ok) {
    throw new Error('Failed to refresh token - please login again');
  }
  
  const { token } = await response.json();
  return token;
}

// Usage
try {
  await sdk.compositeUpload(...);
} catch (e) {
  if (e.message.includes('expired') || e.message.includes('Unauthorized')) {
    const newToken = await refreshToken();
    // Reinitialize SDK with new token
    sdk = new NovaSdk(accountId, { sessionToken: newToken });
    await sdk.compositeUpload(...);  // Retry
  }
}
```

## Error Handling

```typescript
import { NovaError } from 'nova-sdk-js';

try {
  await sdk.compositeUpload('my-group', data, 'file.txt');
} catch (e) {
  if (e instanceof NovaError) {
    if (e.message.includes('expired') || e.message.includes('Unauthorized')) {
      console.error('Session expired - please refresh token');
      // Implement token refresh logic
    } else if (e.message.includes('not authorized')) {
      console.error('Not a member of this group');
    } else if (e.message.includes('Insufficient funds')) {
      console.error('Top up your NEAR balance at nova-sdk.com');
    } else {
      console.error('NOVA error:', e.message);
    }
  } else {
    console.error('Unexpected error:', e);
  }
}
```

## NEAR Deposits

Some operations require NEAR token deposits (paid from user's NOVA account):

- `registerGroup()` - ~0.05 NEAR
- `addGroupMember()` - ~0.001 NEAR
- `revokeGroupMember()` - ~0.001 NEAR
- `upload()` - ~0.003 NEAR (claim token + record Tx)
- `retrieve()` - 0.001 NEAR (claim only)

Ensure your NOVA account has sufficient balance before calling these methods.

## ⚠️ Deprecated Methods

The following methods are deprecated and will be removed in v2.0.0:

| Deprecated | Replacement |
|------------|-------------|
| `compositeUpload()` | `upload()` |
| `compositeRetrieve()` | `retrieve()` |

The deprecated methods still work but emit console warnings.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Submit a pull request

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
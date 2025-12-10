# NOVA SDK for JavaScript

A JavaScript/TypeScript SDK for interacting with the NOVA secure file-sharing on the NEAR blockchain. NOVA hybridizes on-chain group management with off-chain TEE-secured keys via Shade Agents, using nonce-based ed25519-signed tokens for ephemeral, verifiable access. This ensures keys never touch public state, making it ideal for high-value data like AI datasets.


## Features

- 🔐 **AES-256-CBC Encryption** - Client-side encryption for data privacy
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and group access control
- 🛡️ **TEE/Shade Integration** - Keys generated/stored/rotated in verifiable Trusted Execution Environments (Phala); no on-chain exposure
- 🔑 **Automated Signing** - MCP server signs transactions using keys from Shade TEE
- 👥 **Group Management** - Fine-grained membership with automatic key rotation on revocation
- 🚀 **Composite Operations** - Simplified workflows for upload/retrieve
- 📦 **TypeScript Support** - Full type definitions included

## Installation

```bash
npm install nova-sdk-js
```

## Quick Start

```typescript
import { NovaSdk } from 'nova-sdk-js';

// 1. Get your session token from nova-sdk.com after login
const sessionToken = 'eyJhbG...'; // JWT from nova-sdk.com/api/auth/session-token

// 2. Initialize SDK
const sdk = new NovaSdk('alice-nova.nova-sdk-5.testnet', { sessionToken });

// 3. Upload a file
const data = Buffer.from('Hello, NOVA!');
const result = await sdk.compositeUpload('my-group', data, 'hello.txt');
console.log('CID:', result.cid);
```

## Getting Started

1. **Create an account** at nova-sdk.com by connecting your NEAR wallet or email or social.

2. **Get your session token** by calling the session-token API after login:
```bash
# For wallet users:
   curl -X POST https://nova-sdk.com/api/auth/session-token \
     -H "Content-Type: application/json" \
     -d '{"wallet_id": "alice.near"}'
   
   # Response:
   # { "token": "eyJhbG...", "account_id": "alice-nova.nova-sdk-5.testnet" }
```

3. **Use the SDK** with your account ID and session token

## Core Operations

### Upload a File
```typescript
const data = Buffer.from('Hello, NOVA!');
const result = await sdk.compositeUpload('my-group', data, 'hello.txt');

console.log('CID:', result.cid);
console.log('Transaction ID:', result.trans_id);
console.log('Fee:', result.fee_breakdown.total, 'NEAR');
```

### Retrive a File
```typescript
const result = await sdk.compositeRetrieve('my-group', 'QmXyz...');

console.log('Data:', result.data.toString());
console.log('File hash:', result.file_hash);
```

### Group Management
```typescript
// Create a new group (you become owner)
await sdk.registerGroup('my-team');

// Add members
await sdk.addGroupMember('my-team', 'bob-nova.nova-sdk-5.testnet');

// Revoke access (triggers key rotation)
await sdk.revokeGroupMember('my-team', 'bob-nova.nova-sdk-5.testnet');
```

### Check Authorization
```typescript
const isAuthorized = await sdk.isAuthorized('my-group');
console.log('Authorized:', isAuthorized);

const status = await sdk.authStatus('my-group');
console.log('Status:', status);
```

### Security Model

1. **Session token (JWT)** proves you own the account
2. **MCP server** verifies token before any operation
3. **Only the authenticated owner** can use their account
4. **Encryption keys** managed securely in TEE

## Configuration

```typescript
const sdk = new NovaSdk('alice-nova.nova-sdk.near', {
  sessionToken: 'eyJhbG...',                 // Required: JWT from nova-sdk.com
  rpcUrl: 'https://rpc.testnet.near.org',    // Optional: default testnet
  contractId: 'nova-sdk.near',               // Optional: default nova-sdk-5.testnet
  mcpUrl: 'https://nova-mcp.fastmcp.app',    // Optional: rarely change
});
```

## Token Refresh

Session tokens expire after 24 hours. Refresh by calling the session-token endpoint again:

```typescript
async function refreshToken(walletId: string): Promise<string> {
  const response = await fetch('https://nova-sdk.com/api/auth/session-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_id: walletId }),
  });
  const data = await response.json();
  return data.token;
}
```

## Read-Only Queries

These don't require MCP authentication (direct RPC calls):

```typescript
// Check balance
const balance = await sdk.getBalance();

// Get group owner
const owner = await sdk.getGroupOwner('my-group');

// Get fee estimate
const fee = await sdk.estimateFee('record_transaction');

// List transactions
const txs = await sdk.getTransactionsForGroup('my-group');
```

## Error Handling

```typescript
import { NovaError } from 'nova-sdk-js';

try {
  await sdk.compositeUpload('my-group', data, 'file.txt');
} catch (e) {
  if (e instanceof NovaError) {
    if (e.message.includes('expired')) {
      // Token expired - refresh and retry
      const newToken = await refreshToken(walletId);
      // Reinitialize SDK with new token
    }
    console.error('NOVA error:', e.message);
  }
}
```

## NEAR Deposits

Some operations require NEAR token deposits (paid from user's NOVA account):

- `registerGroup()` - ~0.05 NEAR
- `addGroupMember()` - ~0.001 NEAR
- `revokeGroupMember()` - ~0.001 NEAR
- `compositeUpload()` - ~0.003 NEAR (claim token + record Tx)
- `compositeRetrieve()` - 0.001 NEAR (claim only)

Ensure your NOVA account has sufficient balance before calling these methods.

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Submit a pull request

## License

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/nova/LICENSE) file for details.

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
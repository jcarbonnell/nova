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

async function main() {
  // Initialize SDK with email (requires NOVA account at nova-sdk.com)
  const sdk = new NovaSdk({ email: 'user@example.com' });

  // OR with NEAR wallet
  const sdk = new NovaSdk({ walletId: 'alice.near' });

  // OR with known NOVA account ID
  const sdk = new NovaSdk({ accountId: 'alice-nova.nova-sdk-5.testnet' });

  // Upload encrypted file (MCP handles encryption, IPFS, signing)
  const data = Buffer.from('Confidential data');
  const result = await sdk.compositeUpload(
    'project_alpha',      // group_id
    data,                 // data buffer
    'report.txt'          // filename
  );

  console.log('✅ Uploaded to IPFS:', result.cid);
  console.log('📝 Transaction ID:', result.trans_id);
  console.log('🔒 File Hash:', result.file_hash);
  console.log('💰 Fee:', result.fee_breakdown.total, 'NEAR');

  // Retrieve and decrypt file
  const retrieved = await sdk.compositeRetrieve(
    'project_alpha',
    result.cid
  );

  const content = retrieved.data.toString('utf8');
  console.log('📄 Content:', content);
}

main().catch(console.error);
```

## Architecture
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│   Your App  │ ──── │  MCP Server │ ──── │  Shade TEE  │
│  (SDK v3)   │      │  (FastMCP)  │      │   (Phala)   │
└─────────────┘      └─────────────┘      └─────────────┘
                            │
                     ┌──────┴──────┐
                     │             │
              ┌──────┴───┐   ┌─────┴─────┐
              │   NEAR   │   │   IPFS    │
              │ Contract │   │ (Pinata)  │
              └──────────┘   └───────────┘

## Core Concepts

### User Identification
NOVA v3 supports multiple authentication methods:

```typescript
// Email user (Auth0)
const sdk = new NovaSdk({ email: 'user@example.com' });

// NEAR wallet user
const sdk = new NovaSdk({ walletId: 'alice.near' });

// Direct account ID (if already known)
const sdk = new NovaSdk({ accountId: 'alice-nova.nova-sdk-5.testnet' });

// With Auth0 token (for email users in custom apps)
const sdk = new NovaSdk({ 
  email: 'user@example.com',
  authToken: 'jwt-token-from-auth0'
});
```

### Groups

Groups provide isolated access control domains. Each group has:
- A unique identifier (`group_id`)
- An owner who manages membership
- TEE-derived encryption keys (generated in Shade Agent on registration)
- Immutable transaction logs

```typescript
// Register new group (caller becomes owner)
await sdk.registerGroup('secure_vault');

// Add members
await sdk.addGroupMember('secure_vault', 'bob-nova.nova-sdk-5.testnet');

// Check authorization
const authorized = await sdk.isAuthorized('secure_vault');

// Get group owner
const owner = await sdk.getGroupOwner('secure_vault');

// Verify group TEE checksum
const checksum = await sdk.getGroupChecksum('secure_vault');

// Revoke member (automatically rotates key)
await sdk.revokeGroupMember('secure_vault', 'bob-nova.nova-sdk-5.testnet');
```

### Encryption & Signing

All encryption and transaction signing is handled by the MCP server:
- Keys fetched from Shade TEE
- AES-256-CBC encryption with random IV
- Ed25519 signatures for NEAR transactions
- User never handles private keys

Registration triggers Shade key gen; revocation rotates keys off-chain.

## API Reference

### Initialization

```typescript
import { NovaSdk, UserIdentifier, NovaSdkConfig } from 'nova-sdk-js';

const sdk = new NovaSdk(
  userIdentifier: UserIdentifier,
  config?: NovaSdkConfig
);
```

### UserIdentifier

```typescript
interface UserIdentifier {
  email?: string;      // Email (for Auth0 users)
  walletId?: string;   // NEAR wallet ID (e.g., 'alice.near')
  accountId?: string;  // NOVA account (e.g., 'alice-nova.nova-sdk-5.testnet')
  authToken?: string;  // Optional Auth0 JWT
}
```

### NovaSdkConfig

```typescript
interface NovaSdkConfig {
  rpcUrl?: string;     // Default: 'https://rpc.testnet.near.org'
  contractId?: string; // Default: 'nova-sdk-5.testnet'
  mcpUrl?: string;     // Default: 'https://nova-mcp.fastmcp.app'
  shadeUrl?: string;   // Default: 'https://shade-agent-nova.phala.network'
}
```

### User Context

```typescript
// Get resolved NOVA account ID
await sdk.getAccountId(): Promise<string>

// Resolve account from Shade TEE
await sdk.resolveUserAccount(): Promise<{
  accountId?: string;
  publicKey?: string;
  network?: string;
}>

// Check authentication status
await sdk.authStatus(groupId?: string): Promise<AuthStatusResult>
```

### Group Management

```typescript
// Create new group (triggers TEE key generation)
await sdk.registerGroup(groupId: string): Promise<string>

// Grant access to user
await sdk.addGroupMember(groupId: string, memberId: string): Promise<string>

// Revoke access (triggers TEE key rotation)
await sdk.revokeGroupMember(groupId: string, memberId: string): Promise<string>

// Check user authorization
await sdk.isAuthorized(groupId: string, userId?: string): Promise<boolean>

// Get group owner
await sdk.getGroupOwner(groupId: string): Promise<string | null>

// Get TEE checksum
await sdk.getGroupChecksum(groupId: string): Promise<string | null>
```

### File Operations

```typescript
// Upload: Encrypt → IPFS → Record on-chain
await sdk.compositeUpload(
  groupId: string,
  data: Buffer,
  filename: string
): Promise<CompositeUploadResult>

// Retrieve: IPFS → Decrypt
await sdk.compositeRetrieve(
  groupId: string,
  ipfsHash: string
): Promise<CompositeRetrieveResult>

// Query transaction history
await sdk.getTransactionsForGroup(
  groupId: string,
  userId?: string
): Promise<Transaction[]>
```

### Utilities

```typescript
// Check NEAR account balance (in yoctoNEAR)
await sdk.getBalance(accountId?: string): Promise<string>

// Estimate fee for an action
await sdk.estimateFee(action: string): Promise<bigint>

// Compute SHA256 hash
sdk.computeHash(data: Buffer): string
```

## Types

```typescript
interface Transaction {
  group_id: string;
  user_id: string;
  file_hash: string;
  ipfs_hash: string;
}

interface FeeBreakdown {
  claim: number;
  record?: number;
  total: number;
}

interface CompositeUploadResult {
  cid: string;              // IPFS content identifier
  trans_id: string;         // NEAR transaction ID
  file_hash: string;        // SHA256 hash (hex)
  fee_breakdown: FeeBreakdown;
}

interface CompositeRetrieveResult {
  data: Buffer;             // Decrypted file data
  file_hash: string;        // SHA256 hash for verification
  fee_breakdown: FeeBreakdown;
  ipfs_hash: string;
  group_id: string;
}

interface AuthStatusResult {
  authenticated: boolean;
  email?: string;
  wallet_id?: string;
  near_account_id?: string;
  authorized_for_group?: boolean;
}

class NovaError extends Error {
  constructor(message: string, cause?: Error);
}
```

## Environment Setup

For testing and development, set these variables in a `.env` file:

```bash
# NOVA account ID for integration tests
TEST_NOVA_ACCOUNT_ID=your-nova-account.nova-sdk-5.testnet
```


## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

## Error Handling

The SDK uses a custom `NovaError` class:

```typescript
import { NovaSdk, NovaError } from 'nova-sdk-js';

try {
  await sdk.compositeUpload('my_group', data, 'file.txt');
} catch (error) {
  if (error instanceof NovaError) {
    console.error('NOVA error:', error.message);
    if (error.cause) console.error('Caused by:', error.cause);
  }
}
```

Common errors: 
- ```No NOVA account found``` - Create account at nova-sdk.com first
- ```MCP tool failed: Unauthorized``` - User not authorized for group
- ```Invalid CID``` - IPFS hash must start with 'Qm'


## Security Considerations

⚠️ **NOVA v3 Security Model:**

1. **No Client-Side Keys** - Private keys never leave Shade TEE.
2. **MCP as Trusted Intermediary**: Signs on behalf of authenticated users.
3. **TEE Privacy**: Keys in encrypted Shade DB; attested checksums on-chain.
4. **User Authentication**: Email users via Auth0 JWT; wallet users via wallet_id lookup.
5. **IPFS Encryption**: All data encrypted before upload.

## NEAR Deposits

Some operations require NEAR token deposits (paid from user's NOVA account):

- `registerGroup()` - ~0.05 NEAR
- `addGroupMember()` - ~0.001 NEAR
- `revokeGroupMember()` - ~0.001 NEAR
- `compositeUpload()` - ~0.003 NEAR (claim token + record Tx)
- `compositeRetrieve()` - 0.001 NEAR (claim only)

Ensure your NOVA account has sufficient balance before calling these methods.

## Examples

### Secure File Sharing

```typescript
const sdk = new NovaSdk({ email: 'alice@example.com' });

// Create a group
await sdk.registerGroup('team_docs');

// Add collaborator
await sdk.addGroupMember('team_docs', 'bob-nova.nova-sdk-5.testnet');

// Upload confidential document
const doc = Buffer.from('Q3 Financial Report...');
const result = await sdk.compositeUpload('team_docs', doc, 'q3-report.txt');
console.log('Shared at:', result.cid);

// Bob retrieves (using his own SDK instance)
const bobSdk = new NovaSdk({ walletId: 'bob.near' });
const retrieved = await bobSdk.compositeRetrieve('team_docs', result.cid);
console.log('Content:', retrieved.data.toString());
```

### Check Group Status

```typescript
const sdk = new NovaSdk({ accountId: 'alice-nova.nova-sdk-5.testnet' });

// Get group info
const owner = await sdk.getGroupOwner('team_docs');
const checksum = await sdk.getGroupChecksum('team_docs');
const authorized = await sdk.isAuthorized('team_docs');

console.log('Owner:', owner);
console.log('TEE Checksum:', checksum);
console.log('I am authorized:', authorized);

// List transactions
const txs = await sdk.getTransactionsForGroup('team_docs');
txs.forEach(tx => {
  console.log(`File: ${tx.file_hash} → IPFS: ${tx.ipfs_hash}`);
});
```

## Building from Source

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test
```

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
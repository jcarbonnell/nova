# NOVA SDK for JavaScript

A JavaScript/TypeScript SDK for interacting with the NOVA secure file-sharing on the NEAR blockchain. Provides encrypted, decentralized file storage using IPFS and NEAR smart contracts with group-based access control.

## Features

- 🔐 **AES-256-CBC Encryption** - Client-side encryption for data privacy
- 🌐 **IPFS Storage** - Decentralized file storage via Pinata
- ⛓️ **NEAR Blockchain** - Immutable transaction records and access control
- 👥 **Group Management** - Fine-grained access control with member authorization
- 🔑 **Key Rotation** - Automatic key rotation on member revocation
- 🚀 **Composite Operations** - Simplified high-level workflows
- 📦 **TypeScript Support** - Full type definitions included

## Installation

```bash
npm install nova-sdk-js
```

## Quick Start

```typescript
import { NovaSdk } from 'nova-sdk-js';

async function main() {
  // Initialize SDK
  const sdk = new NovaSdk(
    'https://rpc.testnet.near.org',
    'nova-contract.testnet',
    'your_pinata_api_key',
    'your_pinata_secret_key'
  );

  // Attach signer
  await sdk.withSigner(
    'ed25519:your_private_key',
    'your-account.testnet'
  );

  // Upload encrypted file
  const data = Buffer.from('Confidential data');
  const result = await sdk.compositeUpload(
    'project_alpha',      // group_id
    'alice.testnet',      // user_id
    data,                 // data buffer
    'report.txt'          // filename
  );

  console.log('✅ Uploaded to IPFS:', result.cid);
  console.log('📝 Transaction ID:', result.trans_id);
  console.log('🔒 File Hash:', result.file_hash);

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

## Core Concepts

### Groups

Groups provide isolated access control domains. Each group has:
- A unique identifier (`group_id`)
- An owner who manages membership
- A shared encryption key
- A list of authorized members

### Access Control

```typescript
// Register new group (owner only)
await sdk.registerGroup('secure_vault');

// Add members
await sdk.addGroupMember('secure_vault', 'bob.testnet');

// Check authorization
const authorized = await sdk.isAuthorized('secure_vault', 'bob.testnet');

// Revoke member (automatically rotates key)
await sdk.revokeGroupMember('secure_vault', 'bob.testnet');
```

### Encryption

All data is encrypted client-side using AES-256-CBC:
- 256-bit symmetric keys
- Random IV per encryption
- PKCS7 padding
- Keys stored encrypted on blockchain

### Transaction Recording

Every file operation creates an immutable blockchain record:

```typescript
const transId = await sdk.recordTransaction(
  'my_group',
  'alice.testnet',
  'file_hash_sha256',
  'QmIPFSHash'
);

// Query group transactions
const txs = await sdk.getTransactionsForGroup('my_group', 'alice.testnet');
```

## API Overview

### Initialization

```typescript
const sdk = new NovaSdk(
  rpcUrl: string,
  contractId: string,
  pinataKey: string,
  pinataSecret: string
);

// Attach signer for write operations
await sdk.withSigner(privateKey: string, accountId: string);
```

### Group Management

```typescript
// Create new group (requires deposit)
await sdk.registerGroup(groupId: string): Promise<string>

// Grant access to user
await sdk.addGroupMember(groupId: string, userId: string): Promise<string>

// Revoke access and rotate key
await sdk.revokeGroupMember(groupId: string, userId: string): Promise<string>

// Check user authorization
await sdk.isAuthorized(groupId: string, userId: string): Promise<boolean>
```

### Key Management

```typescript
// Store encryption key (owner only)
await sdk.storeGroupKey(groupId: string, keyB64: string): Promise<string>

// Retrieve key (authorized users only)
await sdk.getGroupKey(groupId: string, userId: string): Promise<string>
```

### File Operations

```typescript
// Encrypt, upload to IPFS, record transaction
await sdk.compositeUpload(
  groupId: string,
  userId: string,
  data: Buffer,
  filename: string
): Promise<CompositeUploadResult>

// Fetch from IPFS and decrypt
await sdk.compositeRetrieve(
  groupId: string,
  ipfsHash: string
): Promise<CompositeRetrieveResult>

// Record file metadata on blockchain
await sdk.recordTransaction(
  groupId: string,
  userId: string,
  fileHash: string,
  ipfsHash: string
): Promise<string>

// Query transaction history
await sdk.getTransactionsForGroup(
  groupId: string,
  userId: string
): Promise<Transaction[]>
```

### Utilities

```typescript
// Check NEAR account balance (in yoctoNEAR)
await sdk.getBalance(accountId: string): Promise<string>

// Transfer NEAR tokens
await sdk.transferTokens(toAccount: string, amountYocto: string): Promise<string>
```

## Types

```typescript
interface Transaction {
  group_id: string;
  user_id: string;
  file_hash: string;
  ipfs_hash: string;
}

interface CompositeUploadResult {
  cid: string;        // IPFS content identifier
  trans_id: string;   // NEAR transaction ID
  file_hash: string;  // SHA256 hash (hex)
}

interface CompositeRetrieveResult {
  data: Buffer;       // Decrypted file data
  file_hash: string;  // SHA256 hash for verification
}

class NovaError extends Error {
  constructor(message: string, cause?: Error);
}
```

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
import { NovaError } from 'nova-sdk-js';

try {
  const key = await sdk.getGroupKey('my_group', 'user.testnet');
  console.log('Key:', key);
} catch (error) {
  if (error instanceof NovaError) {
    console.error('NOVA error:', error.message);
    if (error.cause) {
      console.error('Caused by:', error.cause);
    }
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Private Keys** - Never commit private keys to version control
2. **Key Storage** - Store encryption keys securely
3. **IPFS Privacy** - IPFS content is public; encryption is essential
4. **Access Control** - Verify user authorization before operations
5. **Key Rotation** - Revoked members cannot decrypt new content
6. **Buffer Handling** - Use Buffer for binary data to avoid encoding issues

## NEAR Token Deposits

Some operations require NEAR token deposits:

- `registerGroup()` - 0.1 NEAR
- `addGroupMember()` - 0.0005 NEAR
- `revokeGroupMember()` - 0.0005 NEAR
- `storeGroupKey()` - 0.0005 NEAR
- `recordTransaction()` - 0.002 NEAR

Ensure your account has sufficient balance before calling these methods.

## Examples

### Basic File Upload

```typescript
const sdk = new NovaSdk(rpcUrl, contractId, pinataKey, pinataSecret);
await sdk.withSigner(privateKey, accountId);

const fileData = Buffer.from('My secret document');
const result = await sdk.compositeUpload(
  'my_group',
  'user.testnet',
  fileData,
  'secret.txt'
);

console.log('Uploaded:', result.cid);
```

### Group Management

```typescript
// Create group
await sdk.registerGroup('team_alpha');

// Add team members
await sdk.addGroupMember('team_alpha', 'bob.testnet');
await sdk.addGroupMember('team_alpha', 'carol.testnet');

// Verify access
const bobAuth = await sdk.isAuthorized('team_alpha', 'bob.testnet');
console.log('Bob authorized:', bobAuth);

// Remove member
await sdk.revokeGroupMember('team_alpha', 'bob.testnet');
```

### Transaction History

```typescript
const transactions = await sdk.getTransactionsForGroup(
  'my_group',
  'user.testnet'
);

transactions.forEach(tx => {
  console.log(`User: ${tx.user_id}`);
  console.log(`File: ${tx.file_hash}`);
  console.log(`IPFS: ${tx.ipfs_hash}`);
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

This project is licensed under the MIT License - see [LICENSE](https://github.com/jcarbonnell/nova/blob/main/nova-sdk-js/LICENSE) file for details.

## Resources

- [NOVA Documentation](https://github.com/jcarbonnell/nova)
- [NEAR Protocol](https://near.org)
- [IPFS](https://ipfs.io)
- [Pinata](https://pinata.cloud)
- [NEAR JavaScript API](https://docs.near.org/tools/near-api-js/quick-reference)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)
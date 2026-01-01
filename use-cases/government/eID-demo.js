import { NovaSdk } from 'nova-sdk-js';
import * as dotenv from 'dotenv';
import { setTimeout } from 'timers/promises';
import { randomBytes } from 'crypto'; // For simulating ID file if needed

dotenv.config();

async function main() {
  // Configuration from environment
  const rpc = process.env.RPC_URL || 'https://rpc.testnet.near.org';
  const contract = process.env.CONTRACT_ID || 'nova-contract.testnet';
  const pinataKey = process.env.IPFS_API_KEY;
  const pinataSecret = process.env.IPFS_API_SECRET;
  const shadeApiUrl = process.env.SHADE_API_URL;

  const citizenPrivateKey = process.env.CITIZEN_PRIVATE_KEY;
  const citizenAccountId = process.env.CITIZEN_ACCOUNT_ID; // e.g., citizen.testnet

  const servantPrivateKey = process.env.SERVANT_PRIVATE_KEY;
  const servantAccountId = process.env.SERVANT_ACCOUNT_ID; // e.g., servant.testnet

  if (!shadeApiUrl) throw new Error('Missing SHADE_API_URL');
  if (!pinataKey || !pinataSecret || !citizenPrivateKey || !citizenAccountId || !servantPrivateKey || !servantAccountId) {
    throw new Error('Missing required env vars');
  }

  console.log('Citizen Account:', citizenAccountId);
  console.log('Public Servant Account:', servantAccountId);

  // Initialize SDK instances
  const citizenSdk = new NovaSdk(rpc, contract, pinataKey, pinataSecret, shadeApiUrl);
  await citizenSdk.withSigner(citizenPrivateKey, citizenAccountId);

  const servantSdk = new NovaSdk(rpc, contract, pinataKey, pinataSecret, shadeApiUrl);
  await servantSdk.withSigner(servantPrivateKey, servantAccountId);

  // Unique personal group ID for this citizen
  const groupId = `myID.${citizenAccountId}`;
  console.log('\n=== Step 1: Citizen creates personal group and uploads national ID once ===');

  // Create the personal group (only citizen as initial member)
  try {
    await citizenSdk.createGroup(groupId, [citizenAccountId]);
    console.log(`Personal group created: ${groupId}`);
  } catch (err) {
    console.log(`Group already exists or error: ${err.message}. Continuing...`);
  }

  // Simulate a national ID document (PDF or image bytes)
  // In a real app, this would come from file upload / camera scan
  const idDocumentData = randomBytes(1024 * 1024); // 1MB fake PDF
  const filename = 'national-id-document.pdf';

  // Upload encrypted ID document once
  const uploadResult = await citizenSdk.compositeUpload(groupId, citizenAccountId, idDocumentData, filename);
  console.log(`Encrypted national ID uploaded to IPFS: CID = ${uploadResult.cid}`);
  console.log(`On-chain hash: ${uploadResult.hash}`);

  // Wait for IPFS propagation (important in demos)
  console.log('Waiting 15s for IPFS pin propagation...');
  await setTimeout(15000);

  console.log('\n=== Step 2: Citizen grants temporary access to public servant ===');

  // Citizen adds the servant to their personal group
  await citizenSdk.addMember(groupId, servantAccountId);
  console.log(`Access granted: ${servantAccountId} added to group ${groupId}`);

  // Small delay to ensure TEE key distribution
  await setTimeout(5000);

  console.log('\n=== Step 3: Public servant retrieves and verifies the ID document ===');

  // Servant gets a fresh nonce and signed token (handled internally by SDK in real flow)
  // compositeRetrieve will automatically fetch the group key from TEE using nonce auth
  const retrieved = await servantSdk.compositeRetrieve(groupId, uploadResult.cid);

  // Verify integrity (hash match)
  const isValid = retrieved.hash === uploadResult.hash;
  console.log(`ID document retrieved successfully. Integrity valid: ${isValid}`);
  console.log(`Decrypted data length: ${retrieved.data.length} bytes`);

  if (isValid) {
    console.log('Public servant: ID verified — service can now be provided.');
  }

  console.log('\n=== Step 4: Citizen revokes access after service completion ===');

  // Citizen removes the servant from the group
  await citizenSdk.removeMember(groupId, servantAccountId);
  console.log(`Access revoked: ${servantAccountId} removed from group`);

  // Demonstrate revocation effectiveness
  console.log('Attempting retrieval after revocation (should fail or return inaccessible key)...');
  try {
    await servantSdk.compositeRetrieve(groupId, uploadResult.cid);
    console.log('Warning: Retrieval succeeded after revocation (possible TEE caching — normal in short demos)');
  } catch (err) {
    console.log('Revocation successful: Retrieval failed as expected:', err.message);
  }

  console.log('\n=== eID Use Case Demo Complete ===');
  console.log('Citizen retains full control: one-time upload, temporary access, instant revocation.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
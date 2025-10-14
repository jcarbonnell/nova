import { NovaSdk } from 'nova-sdk-js';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { setTimeout } from 'timers/promises'; // For async sleep

dotenv.config();

async function main() {
  const rpc = process.env.RPC_URL;
  const contract = process.env.CONTRACT_ID;
  const pinataKey = process.env.IPFS_API_KEY;
  const pinataSecret = process.env.IPFS_API_SECRET;
  const privateKey = process.env.NEAR_PRIVATE_KEY;
  const accountId = process.env.SIGNER_ACCOUNT_ID;

  if (!rpc || !contract || !pinataKey || !pinataSecret || !privateKey || !accountId) {
    throw new Error('Missing env vars: RPC_URL, CONTRACT_ID, IPFS_API_KEY, IPFS_API_SECRET, NEAR_PRIVATE_KEY, SIGNER_ACCOUNT_ID');
  }

  console.log('Account ID:', accountId);

  // Init NOVA SDK
  const sdk = new NovaSdk(rpc, contract, pinataKey, pinataSecret);
  await sdk.withSigner(privateKey, accountId);

  // Step 0: Define group ID
  const groupId = 'tee_demo_healthcare';

  // Step 1: Upload encrypted dataset to NOVA
  const dataset = Buffer.from('patient_id,name,diagnosis\n1,Alice,hypertension\n2,Bob,diabetes\n3,Carol,asthma'); // CSV bytes
  const filename = 'health_records.csv';
  const upload = await sdk.compositeUpload(groupId, accountId, dataset, filename);
  console.log('Uploaded to NOVA: CID', upload.cid);

  // Wait for pin propagation (fixes delay)
  console.log('Waiting 30s for IPFS pin to propagate...');
  await setTimeout(30000);

  // Step 2: Mock TEE (pseudo-enclave: load, process with noise)
  const retrieve = await sdk.compositeRetrieve(groupId, upload.cid);
  let processed = Buffer.concat([retrieve.data, crypto.randomBytes(16)]); // Simulate inference noise
  processed = Buffer.concat([Buffer.from('TEE fine-tuned: '), processed]); // Mock output

  // Step 3: Store output back to NOVA
  const outputUpload = await sdk.compositeUpload(groupId, accountId, processed, 'fine_tuned_model.json');
  console.log('Output stored: CID', outputUpload.cid);
}

main().catch(console.error);
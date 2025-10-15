import { NovaSdk } from 'nova-sdk-js';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { setTimeout } from 'timers/promises';

dotenv.config();

async function main() {
  const rpc = process.env.RPC_URL;
  const contract = process.env.CONTRACT_ID;
  const pinataKey = process.env.IPFS_API_KEY;
  const pinataSecret = process.env.IPFS_API_SECRET;
  const privateKeyA = process.env.NEAR_PRIVATE_KEY;
  const accountIdA = process.env.SIGNER_ACCOUNT_ID;
  const privateKeyB = process.env.PARTICIPANT_KEY;
  const accountIdB = process.env.PARTICIPANT_ACCOUNT;

  if (!rpc || !contract || !pinataKey || !pinataSecret || !privateKeyA || !accountIdA || !privateKeyB || !accountIdB) {
    throw new Error('Missing env vars: RPC_URL, CONTRACT_ID, IPFS_API_KEY, IPFS_API_SECRET, NEAR_PRIVATE_KEY, SIGNER_ACCOUNT_ID, PARTICIPANT_KEY, PARTICIPANT_ACCOUNT');
  }

  console.log('Primary Account ID (Hospital A):', accountIdA);
  console.log('Secondary Account ID (Hospital B):', accountIdB);

  // Init NOVA SDK for Hospital A
  const sdkA = new NovaSdk(rpc, contract, pinataKey, pinataSecret);
  await sdkA.withSigner(privateKeyA, accountIdA);
  
  // Init NOVA SDK for Hospital B
  const sdkB = new NovaSdk(rpc, contract, pinataKey, pinataSecret);
  await sdkB.withSigner(privateKeyB, accountIdB);

  // Step 0: Define group ID
  const groupId = 'tee_demo_healthcare';

  // Step 1: Hospital A uploads encrypted dataset to NOVA
  const dataset = Buffer.from('patient_id,name,diagnosis\n1,Alice,hypertension\n2,Bob,diabetes\n3,Carol,asthma'); // CSV bytes
  const filenameA = 'health_records_a.csv';
  const uploadA = await sdkA.compositeUpload(groupId, accountIdA, dataset, filenameA);
  console.log('Hospital A uploaded to NOVA: CID', uploadA.cid);

  // Wait for pin propagation (fixes delay)
  console.log('Waiting 30s for IPFS pin to propagate...');
  await setTimeout(30000);

  // Step 2: Hospital B retrieves and processes the data through the TEE
  const retrieveB = await sdkB.compositeRetrieve(groupId, uploadA.cid);
  let processedB = Buffer.concat([retrieveB.data, crypto.randomBytes(16)]); // Simulate inference noise
  processedB = Buffer.concat([Buffer.from('TEE processed by B: '), processedB]); // Mock output

  // Step 3: Hospital B stores output back to NOVA
  const outputUploadB = await sdkB.compositeUpload(groupId, accountIdB, processedB, 'fine_tuned_model_b.json');
  console.log('Hospital B output stored: CID', outputUploadB.cid);

  // Wait for pin propagation
  console.log('Waiting 30s for IPFS pin to propagate...');
  await setTimeout(30000);

  // Step 4: Hospital A retrieves B's data, processes it, and uploads final output
  const retrieveA = await sdkA.compositeRetrieve(groupId, outputUploadB.cid);
  let processedA = Buffer.concat([retrieveA.data, crypto.randomBytes(16)]); // Simulate final inference noise
  processedA = Buffer.concat([Buffer.from('Final TEE aggregated by A: '), processedA]); // Mock final output

  const finalUpload = await sdkA.compositeUpload(groupId, accountIdA, processedA, 'final_aggregated_model.json');
  console.log('Hospital A final output stored: CID', finalUpload.cid);
}

main().catch(console.error);
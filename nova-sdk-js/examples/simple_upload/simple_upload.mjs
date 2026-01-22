// examples/simple_upload.mjs
// 
// Test NOVA SDK with automatic token management
//
// Usage:
//   export TEST_NOVA_ACCOUNT_ID="yourname.nova-sdk.near"
//   node simple_upload.mjs

import { NovaSdk } from 'nova-sdk-js';
import { Buffer } from 'buffer';
import 'dotenv/config';

async function main() {
  const accountId = process.env.NOVA_ACCOUNT_ID;
  const apiKey = process.env.NOVA_API_KEY;

  if (!accountId) {
    console.error('❌ Set TEST_NOVA_ACCOUNT_ID environment variable');
    console.error('   Example: export TEST_NOVA_ACCOUNT_ID="alice.nova-sdk.near"');
    process.exit(1);
  }
  
  console.log('🚀 NOVA SDK Test (mainnet)\n');

  // Initialize SDK with API key
  const sdk = new NovaSdk(accountId, { apiKey });

  console.log('📋 Configuration:');
  console.log(`   Account:  ${sdk.accountId}`);
  console.log(`   Network:  ${sdk.networkId}`);
  console.log(`   Contract: ${sdk.contractId}`);

  const groupId = 'sdk_test_group';

  // 1. Auth check (triggers auto token fetch)
  console.log('\n🔐 Authenticating...');
  try {
    const status = await sdk.authStatus(groupId);
    console.log(`   ✅ Authenticated as: ${status.near_account_id}`);
  } catch (e) {
    console.error(`   ❌ Auth failed: ${e.message}`);
    process.exit(1);
  }

  // 2. Create group
  console.log(`\n📁 Creating group '${groupId}'...`);
  try {
    const msg = await sdk.registerGroup(groupId);
    console.log(`   ✅ ${msg}`);
  } catch (e) {
    if (e.message.includes('exists') || e.message.includes('already')) {
      console.log('   ⚠️  Group already exists (OK)');
    } else {
      console.log(`   ⚠️  ${e.message} (continuing...)`);
    }
  }

  // 3. Upload file
  const testData = Buffer.from(
    `Hello NOVA! 🔐\n` +
    `Timestamp: ${new Date().toISOString()}\n` +
    `This file is encrypted client-side with AES-256-GCM.`
  );
  const filename = 'test_file.txt';

  console.log(`\n📤 Uploading '${filename}' (${testData.length} bytes)...`);
  let uploadResult;
  try {
    const start = Date.now();
    uploadResult = await sdk.upload(groupId, testData, filename);
    console.log(`   ✅ Uploaded in ${Date.now() - start}ms`);
    console.log(`   📍 CID: ${uploadResult.cid}`);
    console.log(`   🔗 TX:  ${uploadResult.trans_id}`);
  } catch (e) {
    console.error(`   ❌ Upload failed: ${e.message}`);
    process.exit(1);
  }

  // 4. Retrieve file
  console.log(`\n📥 Retrieving '${uploadResult.cid}'...`);
  let retrieveResult;
  try {
    const start = Date.now();
    retrieveResult = await sdk.retrieve(groupId, uploadResult.cid);
    console.log(`   ✅ Retrieved in ${Date.now() - start}ms`);
    console.log(`   📦 Size: ${retrieveResult.data.length} bytes`);
  } catch (e) {
    console.error(`   ❌ Retrieve failed: ${e.message}`);
    process.exit(1);
  }

  // 5. Verify integrity
  console.log('\n🔍 Verifying data integrity...');
  const originalHash = await sdk.computeHashAsync(testData);
  const retrievedHash = await sdk.computeHashAsync(retrieveResult.data);
  
  if (originalHash === retrievedHash && Buffer.compare(testData, retrieveResult.data) === 0) {
    console.log('   ✅ Data integrity verified!');
    console.log('\n📄 Content:');
    console.log('   ' + retrieveResult.data.toString().split('\n').join('\n   '));
  } else {
    console.error('   ❌ Data mismatch!');
    console.error(`   Original hash:  ${originalHash}`);
    console.error(`   Retrieved hash: ${retrievedHash}`);
    process.exit(1);
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('🎉 SUCCESS! End-to-end test complete.');
  console.log('═'.repeat(50));
  console.log('\nYour file is now:');
  console.log(`  🔐 Encrypted with AES-256-GCM (client-side)`);
  console.log(`  📦 Stored on IPFS: ${uploadResult.cid}`);
  console.log(`  ⛓️  Recorded on NEAR: ${uploadResult.trans_id}`);
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  if (e.cause) console.error('   Cause:', e.cause.message);
  process.exit(1);
});
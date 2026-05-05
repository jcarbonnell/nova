// test-upload.mjs
import { NovaSdk } from 'nova-sdk-js';
import { readFileSync } from 'fs';

const API_KEY = 'nova_sk_JsPqb3RRkLXeAuOcCdxZWzPPjxQ65bRP8job4BAtsJc';
const ACCOUNT_ID = 'hello-partage.nova-sdk.near';

async function main() {
  console.log('🚀 NOVA SDK Upload Test\n');

  const sdk = new NovaSdk(ACCOUNT_ID, { apiKey: API_KEY });

  console.log('📋 Configuration:');
  console.log(`   Account:  ${sdk.accountId}`);
  console.log(`   Network:  ${sdk.networkId}`);
  console.log(`   Contract: ${sdk.contractId}\n`);

  const groupId = 'csv_test_group';

  // 1. Auth check
  console.log('🔐 Authenticating...');
  try {
    const status = await sdk.authStatus(groupId);
    console.log(`   ✅ Authenticated as: ${status.near_account_id}`);
  } catch (e) {
    console.log(`   ⚠️  Auth check: ${e.message}`);
  }

  // 2. Create group (critical step)
  console.log(`\n📁 Creating group '${groupId}'...`);
  try {
    const msg = await sdk.registerGroup(groupId);
    console.log(`   ✅ ${msg}`);
    console.log(`   ⏳ Waiting 3s for blockchain confirmation...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  } catch (e) {
    if (e.message.includes('exists') || e.message.includes('already')) {
      console.log('   ✅ Group already exists');
    } else {
      console.error(`   ❌ Failed to create group: ${e.message}`);
      console.error('   💡 Make sure your account has enough NEAR balance');
      process.exit(1);
    }
  }

  // 3. Read CSV
  console.log('\n📄 Reading test-sample.csv...');
  const csvData = readFileSync('test-sample.csv');
  console.log(`   📦 Size: ${csvData.length} bytes`);
  console.log(`   📊 Preview: ${csvData.toString().split('\n')[0].substring(0, 50)}...`);

  // 4. Upload
  console.log(`\n📤 Uploading to NOVA...`);
  const start = Date.now();
  try {
    const uploadResult = await sdk.upload(groupId, csvData, 'test-sample.csv');
    console.log(`   ✅ Uploaded in ${Date.now() - start}ms`);
    console.log(`   📍 CID: ${uploadResult.cid}`);
    console.log(`   🔗 TX:  ${uploadResult.trans_id}`);
    console.log(`   🔐 Hash: ${uploadResult.file_hash?.substring(0, 16)}...`);

    // 5. Retrieve
    console.log(`\n📥 Retrieving from IPFS...`);
    const start2 = Date.now();
    const retrieveResult = await sdk.retrieve(groupId, uploadResult.cid);
    console.log(`   ✅ Retrieved in ${Date.now() - start2}ms`);
    console.log(`   📦 Size: ${retrieveResult.data.length} bytes`);

    // 6. Verify
    console.log('\n🔍 Verifying data integrity...');
    const originalHash = await sdk.computeHashAsync(csvData);
    const retrievedHash = await sdk.computeHashAsync(retrieveResult.data);
    
    if (originalHash === retrievedHash) {
      console.log('   ✅ Data integrity verified!');
      const preview = retrieveResult.data.toString().split('\n').slice(0, 3).join('\n   ');
      console.log('\n📄 Retrieved CSV (first 3 lines):');
      console.log('   ' + preview);
    } else {
      console.error('   ❌ Hash mismatch!');
      console.error(`   Original:  ${originalHash}`);
      console.error(`   Retrieved: ${retrievedHash}`);
      process.exit(1);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('🎉 SUCCESS! Your CSV is now:');
    console.log('═'.repeat(60));
    console.log(`  🔐 Encrypted client-side with AES-256-GCM`);
    console.log(`  📦 Stored on IPFS: ${uploadResult.cid}`);
    console.log(`  ⛓️  Recorded on NEAR: ${uploadResult.trans_id}`);
    console.log(`  🌐 View on explorer: https://nearblocks.io/txns/${uploadResult.trans_id}`);
  } catch (e) {
    console.error(`\n💥 Upload failed: ${e.message}`);
    if (e.cause) console.error(`   Cause: ${e.cause}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n💥 Fatal error:', e.message);
  process.exit(1);
});
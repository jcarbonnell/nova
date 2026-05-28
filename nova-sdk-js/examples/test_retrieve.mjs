// test_retrieve.mjs — retrieve & decrypt the file uploaded by the nova-submit WASM tool
import { NovaSdk } from 'nova-sdk-js';

const API_KEY    = '<your-freshly-rotated-key>';
const ACCOUNT_ID = 'ironclaw-hackathon.nova-sdk.near';
const GROUP_ID   = 'ironclaw-hackathon-260618';
const CID        = 'QmZGeVLWi3Z5ekZa9PHd9deBSXCTpWmN2byVnzQphNgQ7v';

async function main() {
  console.log('🔍 NOVA retrieve test (mainnet)\n');

  // Testnet overrides — without these the SDK defaults to mainnet.
  const sdk = new NovaSdk(ACCOUNT_ID, { apiKey: API_KEY });
  console.log(`   Account:  ${sdk.accountId}`);
  console.log(`   Network:  ${sdk.networkId}`);

  const r = await sdk.retrieve(GROUP_ID, CID);
  const text = r.data.toString('utf-8');
  console.log(`   ✅ Retrieved ${r.data.length} bytes\n`);
  console.log(`DECRYPTED: ${JSON.stringify(text)}`);

  if (text === 'hello nova submit test') {
    console.log('\n🎉 MAINNET ROUND-TRIP CONFIRMED.');
  } else {
    console.log('\n❌ MISMATCH.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n💥 Failed:', e.message);
  if (e.cause) console.error('   Cause:', e.cause);
  process.exit(1);
});
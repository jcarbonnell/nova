// test-config-extraction.mjs
// Run: npm run build && node test-config-extraction.mjs
//
// Step 9 config centralization is a ZERO-BEHAVIOUR-CHANGE refactor. This proves
// every value resolves byte-identically to the pre-config inline reads, for both
// a production-shaped env and the all-unset (defaults) case.

// Prod-shaped env MUST be set before the first import — config.ts reads at load.
const PROD_ENV = {
  NEAR_RPC_URL: 'https://rpc.mainnet.fastnear.com?apiKey=TESTKEY',
  NEAR_TESTNET_RPC_URL: 'https://rpc.testnet.fastnear.com?apiKey=TESTKEY',
  KV_CONTRACT_ID: 'nova-kv.near',
  KV_CONTRACT_OWNER_ID: 'nova-sdk.near',
  NOVA_MAINNET_CONTRACT: 'nova-sdk.near',
  NOVA_TESTNET_CONTRACT: 'nova-sdk-6.testnet',
};
for (const [k, v] of Object.entries(PROD_ENV)) process.env[k] = v;

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     expected: ${expected}\n     actual:   ${actual}`); }
};

// Natural (uncached-query) imports so config/kv/near share ONE module instance.
const config = await import('./dist/lib/config.js');
const kv     = await import('./dist/lib/kv.js');
const near   = await import('./dist/lib/near.js');

console.log('\n1. Env-driven resolution (production shape)');
eq('getRpcUrl(mainnet)', config.getRpcUrl('mainnet'), PROD_ENV.NEAR_RPC_URL);
eq('getRpcUrl(testnet)', config.getRpcUrl('testnet'), PROD_ENV.NEAR_TESTNET_RPC_URL);
eq('getRpcUrl(unknown) → mainnet', config.getRpcUrl('whatever'), PROD_ENV.NEAR_RPC_URL);
eq('KV_CONTRACT', config.KV_CONTRACT, 'nova-kv.near');
eq('KV_CONTRACT_OWNER', config.KV_CONTRACT_OWNER, 'nova-sdk.near');
eq('NOVA_MAINNET_CONTRACT', config.NOVA_MAINNET_CONTRACT, 'nova-sdk.near');
eq('NOVA_TESTNET_CONTRACT', config.NOVA_TESTNET_CONTRACT, 'nova-sdk-6.testnet');

console.log('\n2. Single-network KV invariant');
eq('KV_RPC_URL === NEAR_RPC_URL', config.KV_RPC_URL, config.NEAR_RPC_URL);
eq('KV_RPC_URL is NOT the testnet URL',
   config.KV_RPC_URL === config.NEAR_TESTNET_RPC_URL, false);

console.log('\n3. Cross-module consistency (re-exports)');
eq('kv.KV_CONTRACT', kv.KV_CONTRACT, config.KV_CONTRACT);
eq('kv.KV_CONTRACT_OWNER', kv.KV_CONTRACT_OWNER, config.KV_CONTRACT_OWNER);
eq('near.getRpcUrl is config.getRpcUrl', near.getRpcUrl, config.getRpcUrl);
eq('near.DEFAULT_MAINNET_CONTRACT', near.DEFAULT_MAINNET_CONTRACT, config.NOVA_MAINNET_CONTRACT);
eq('near.DEFAULT_TESTNET_CONTRACT', near.DEFAULT_TESTNET_CONTRACT, config.NOVA_TESTNET_CONTRACT);

console.log('\n4. resolveContract unchanged');
eq('mainnet id → mainnet', near.resolveContract('nova-sdk.near').network, 'mainnet');
eq('testnet id → testnet', near.resolveContract('nova-sdk-6.testnet').network, 'testnet');
eq('unknown id → mainnet fallback', near.resolveContract('evil.near').contractId, 'nova-sdk.near');
eq('undefined → mainnet fallback', near.resolveContract(undefined).contractId, 'nova-sdk.near');

console.log('\n5. SHADE_AGENT_ACCOUNT_ID is a getter (7.5: written after module load)');
delete process.env.SHADE_AGENT_ACCOUNT_ID;
eq('undefined before bootstrap', config.shadeAgentAccountId(), undefined);
process.env.SHADE_AGENT_ACCOUNT_ID = '74073d8d417459b75466fa2b';
eq('reflects post-load mutation', config.shadeAgentAccountId(), '74073d8d417459b75466fa2b');
delete process.env.SHADE_AGENT_ACCOUNT_ID;

console.log('\n6. Defaults with env UNSET — must match the old hardcoded literals');
for (const k of Object.keys(PROD_ENV)) delete process.env[k];
const bare = await import('./dist/lib/config.js?bare=1');  // query busts ESM cache
eq('NEAR_RPC_URL default', bare.NEAR_RPC_URL, 'https://rpc.mainnet.fastnear.com');
eq('NEAR_TESTNET_RPC_URL default', bare.NEAR_TESTNET_RPC_URL, 'https://rpc.testnet.fastnear.com');
eq('KV_CONTRACT default', bare.KV_CONTRACT, 'nova-kv.near');
eq('KV_CONTRACT_OWNER default', bare.KV_CONTRACT_OWNER, 'nova-sdk.near');
eq('NOVA_MAINNET_CONTRACT default', bare.NOVA_MAINNET_CONTRACT, 'nova-sdk.near');
eq('NOVA_TESTNET_CONTRACT default', bare.NOVA_TESTNET_CONTRACT, 'nova-sdk-6.testnet');
eq('KV_RPC_URL default === mainnet default', bare.KV_RPC_URL, 'https://rpc.mainnet.fastnear.com');

console.log(`\n${'─'.repeat(52)}\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
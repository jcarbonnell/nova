// shade-agent/test/test-boot-config.mjs
//
// §5.12 item 1c-iv — lib/boot-config.ts. Proves, OFFLINE:
//   B1 a minimal valid environment boots (no sponsor, no TEE_KEY_SECRET)
//   B2 each required variable missing → refused, named in the message
//   B3 production + TEE_KEY_SECRET or MASTER_SEED_INIT_ALLOWED → refused
//   B4 outside production, a leftover TEE_KEY_SECRET is tolerated (local dev)
//   B5 sponsor half-set → refused
//   B6 sponsor = nova-sdk.near, the agent contract or the KV contract → refused
//   B7 a dedicated sponsor is accepted and returned
//   B8 network follows the agent contract suffix
// Every refusal is asserted by its message.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 drop the production leftover-secret check               → B3
//   M2 drop the forbidden-sponsor check                        → B6
//   M3 accept a half-set sponsor (delete the pairing check)    → B5
//
// Build first:  npm run build
// Run:          node ./test/test-boot-config.mjs

import { validateBootEnv, BootConfigError } from '../dist/lib/boot-config.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = (fn, needle) => {
  try { fn(); return false; } catch (e) { return e instanceof BootConfigError && e.message.includes(needle); }
};

const BASE = Object.freeze({
  NODE_ENV: 'production',
  AGENT_CONTRACT_ID: 'shade-agent.nova-sdk.near',
  KV_CONTRACT_ID: 'nova-kv-2.near',
  AUTH0_DOMAIN: 'example.auth0.com',
});

console.log('boot config');

await check('B1 minimal valid environment boots (no sponsor, no TEE_KEY_SECRET)', () => {
  const c = validateBootEnv({ ...BASE });
  return c.sponsor === null && c.isProduction === true && c.kvContractId === 'nova-kv-2.near';
});

await check('B2 each required variable missing → refused, named', () =>
  ['AGENT_CONTRACT_ID', 'KV_CONTRACT_ID', 'AUTH0_DOMAIN'].every((k) => {
    const env = { ...BASE }; delete env[k];
    return refuses(() => validateBootEnv(env), `Missing required environment variables: ${k}`);
  }));

await check('B3 production + TEE_KEY_SECRET or MASTER_SEED_INIT_ALLOWED → refused', () =>
  refuses(() => validateBootEnv({ ...BASE, TEE_KEY_SECRET: 'ab'.repeat(32) }), 'Retired root secret(s) still set: TEE_KEY_SECRET')
  && refuses(() => validateBootEnv({ ...BASE, MASTER_SEED_INIT_ALLOWED: 'false' }), 'Retired root secret(s) still set: MASTER_SEED_INIT_ALLOWED'));

await check('B4 outside production, a leftover TEE_KEY_SECRET is tolerated', () =>
  validateBootEnv({ ...BASE, NODE_ENV: 'development', TEE_KEY_SECRET: 'x' }).isProduction === false);

await check('B5 sponsor half-set → refused', () =>
  refuses(() => validateBootEnv({ ...BASE, SPONSOR_ACCOUNT_ID: 'nova-sponsor.near' }), 'must be set together')
  && refuses(() => validateBootEnv({ ...BASE, SPONSOR_PRIVATE_KEY: 'ed25519:x' }), 'must be set together'));

await check('B6 sponsor = nova-sdk.near / agent contract / KV contract → refused', () =>
  ['nova-sdk.near', 'shade-agent.nova-sdk.near', 'nova-kv-2.near'].every((a) =>
    refuses(() => validateBootEnv({ ...BASE, SPONSOR_ACCOUNT_ID: a, SPONSOR_PRIVATE_KEY: 'ed25519:x' }),
      `must be a dedicated funding account, not ${a}`)));

await check('B7 a dedicated sponsor is accepted and returned', () => {
  const c = validateBootEnv({ ...BASE, SPONSOR_ACCOUNT_ID: 'nova-sponsor.near', SPONSOR_PRIVATE_KEY: 'ed25519:x' });
  return c.sponsor?.accountId === 'nova-sponsor.near' && c.sponsor?.privateKey === 'ed25519:x';
});

await check('B8 network follows the agent contract suffix', () =>
  validateBootEnv({ ...BASE }).network === 'mainnet'
  && validateBootEnv({ ...BASE, AGENT_CONTRACT_ID: 'ac.nova.testnet' }).network === 'testnet');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

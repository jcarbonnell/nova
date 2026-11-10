// shade-agent/test/test-boot-config.mjs
//
// §5.12 R4 — lib/boot-config.ts on the portable design. Proves, OFFLINE:
//   B1 a minimal valid environment boots (no sponsor)
//   B2 each required variable missing (incl. TEE_KEY_SECRET) → refused, named
//   B3 production + MASTER_SEED_INIT_ALLOWED (any value) → refused
//   B4 outside production, a leftover MASTER_SEED_INIT_ALLOWED is tolerated (local dev)
//   B5 sponsor half-set → refused
//   B6 sponsor = nova-sdk.near, the agent contract or the KV contract → refused
//   B7 a dedicated sponsor is accepted and returned
//   B8 network follows the agent contract suffix
//   B9 TEE_KEY_SECRET too short, too long or not hex → refused
// Every refusal is asserted by its message.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 drop the production leftover-secret check               → B3
//   M2 drop the forbidden-sponsor check                        → B6
//   M3 accept a half-set sponsor (delete the pairing check)    → B5
//   M4 drop the TEE_KEY_SECRET format check                    → B9
//
// Build first:  npm run build
// Run:          node ./test/test-boot-config.mjs

import crypto from 'node:crypto';
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
  TEE_KEY_SECRET: crypto.randomBytes(32).toString('hex'), // throwaway
});

console.log('boot config');

await check('B1 minimal valid environment boots (no sponsor)', () => {
  const c = validateBootEnv({ ...BASE });
  return c.sponsor === null && c.isProduction === true && c.kvContractId === 'nova-kv-2.near';
});

await check('B2 each required variable missing → refused, named', () =>
  ['AGENT_CONTRACT_ID', 'KV_CONTRACT_ID', 'AUTH0_DOMAIN', 'TEE_KEY_SECRET'].every((k) => {
    const env = { ...BASE }; delete env[k];
    return refuses(() => validateBootEnv(env), `Missing required environment variables: ${k}`);
  }));

await check('B3 production + MASTER_SEED_INIT_ALLOWED (any value) → refused', () =>
  ['true', 'false'].every((v) =>
    refuses(() => validateBootEnv({ ...BASE, MASTER_SEED_INIT_ALLOWED: v }),
      'Retired variable(s) still set: MASTER_SEED_INIT_ALLOWED')));

await check('B4 outside production, a leftover MASTER_SEED_INIT_ALLOWED is tolerated', () =>
  validateBootEnv({ ...BASE, NODE_ENV: 'development', MASTER_SEED_INIT_ALLOWED: 'true' }).isProduction === false);

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

await check('B9 TEE_KEY_SECRET too short, too long or not hex → refused', () =>
  ['ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32)].every((bad) =>
    refuses(() => validateBootEnv({ ...BASE, TEE_KEY_SECRET: bad }), 'TEE_KEY_SECRET must be a 64-char hex string')));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

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
//   B10 §5.12 hardening: KV_CONTRACT_ID = nova-kv.near (the pre-switch KV) → refused,
//       and boot-config's constant is lib/legacy.ts's LEGACY_KV_CONTRACT
//   B11 AUTH0_AUDIENCE not an https URL, or with a trailing slash → refused
//   B12 no source file names the old CVM (5a5223f7… / dstack-prod5), and config.ts
//       has no KV contract default
// Every refusal is asserted by its message.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 drop the production leftover-secret check               → B3
//   M2 drop the forbidden-sponsor check                        → B6
//   M3 accept a half-set sponsor (delete the pairing check)    → B5
//   M4 drop the TEE_KEY_SECRET format check                    → B9
//   M5–M7: test/mutate-hardening.mjs (B10, B11, auth regression)
//
// Build first:  npm run build
// Run:          node ./test/test-boot-config.mjs

import crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  AUTH0_AUDIENCE: 'https://nova-sdk.com/api/shade',
  TEE_KEY_SECRET: crypto.randomBytes(32).toString('hex'), // throwaway
});

console.log('boot config');

await check('B1 minimal valid environment boots (no sponsor)', () => {
  const c = validateBootEnv({ ...BASE });
  return c.sponsor === null && c.isProduction === true && c.kvContractId === 'nova-kv-2.near';
});

await check('B2 each required variable missing → refused, named', () =>
  ['AGENT_CONTRACT_ID', 'KV_CONTRACT_ID', 'AUTH0_DOMAIN', 'AUTH0_AUDIENCE', 'TEE_KEY_SECRET'].every((k) => {
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

await check('B10 KV_CONTRACT_ID = nova-kv.near (pre-switch) → refused; one constant with lib/legacy.ts', async () => {
  const { PRE_SWITCH_KV_CONTRACT } = await import('../dist/lib/boot-config.js');
  const src = readFileSync(new URL('../dist/lib/legacy.js', import.meta.url), 'utf8');
  return refuses(() => validateBootEnv({ ...BASE, KV_CONTRACT_ID: 'nova-kv.near' }), 'KV_CONTRACT_ID must not be the pre-switch nova-kv.near')
    && PRE_SWITCH_KV_CONTRACT === 'nova-kv.near' && src.includes("export const LEGACY_KV_CONTRACT = 'nova-kv.near';");
});

await check('B11 AUTH0_AUDIENCE not https, or with a trailing slash → refused', () =>
  ['http://nova-sdk.com/api/shade', 'nova-sdk.com/api/shade', 'https://nova-sdk.com/api/shade/'].every((a) =>
    refuses(() => validateBootEnv({ ...BASE, AUTH0_AUDIENCE: a }), 'AUTH0_AUDIENCE must be an https URL without a trailing slash'))
  && validateBootEnv({ ...BASE }).auth0Audience === 'https://nova-sdk.com/api/shade');

await check('B12 no source names the old CVM; config.ts has no KV contract default', () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const files = readdirSync(root, { recursive: true }).filter((f) => /\.ts$/.test(f));
  const stale = files.filter((f) => /5a5223f7|dstack-prod5\./.test(readFileSync(join(root, f), 'utf8')));
  const cfg = readFileSync(join(root, 'lib/config.ts'), 'utf8');
  return files.length > 20 && stale.length === 0 && cfg.includes("process.env.KV_CONTRACT_ID || '';") && !/KV_CONTRACT_ID \|\| 'nova-kv/.test(cfg);
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

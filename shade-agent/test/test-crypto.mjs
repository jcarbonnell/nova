// shade-agent/test/test-crypto.mjs
//
// §5.12 R1 — lib/crypto.ts on the portable design: blob key from TEE_KEY_SECRET
// (env), master seed held here after lib/seed.ts loads it. Proves, OFFLINE:
//   C1 encryptBlob → decryptBlob round-trips; stored layout starts with "NOVG"
//   C2 a blob does not open under a different TEE_KEY_SECRET
//   C3 legacy CBC blobs are refused (string "iv:enc" form and raw-bytes form),
//      even when they were made with the right key
//   C4 a tampered blob is refused (GCM authentication)
//   C5 TEE_KEY_SECRET missing, too short, or not hex → refused by name
//   C6 deriveKey = HKDF-SHA256(master seed, salt, info "nova-v1")
//   C7 before setMasterSeed: getMasterSeedSync/deriveKey throw; hasMasterSeed false → true
//   C8 number[] input (KV's raw form) decrypts
//   C9 the module no longer depends on the TEE key path (no tee-keys import)
// Every refusal is asserted by its message. Test secrets are random, never real.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 blobKey() returns a constant 32-byte key            → C2
//   M2 decryptBlob: drop the "Legacy CBC" refusal          → C3
//   M3 deriveKey uses info "nova-v2"                       → C6
//   M4 setMasterSeed does nothing                          → C6, C7
//
// Build first:  npm run build
// Run:          node ./test/test-crypto.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  encryptBlob, decryptBlob, deriveKey,
  hasMasterSeed, getMasterSeedSync, setMasterSeed,
} from '../dist/lib/crypto.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = async (fn, needle) => {
  try { await fn(); return false; } catch (e) { return String(e?.message).includes(needle); }
};
const randomSecret = () => crypto.randomBytes(32).toString('hex');
const SECRET_A = randomSecret();
const SECRET_B = randomSecret();
const useSecret = (s) => { if (s === undefined) delete process.env.TEE_KEY_SECRET; else process.env.TEE_KEY_SECRET = s; };

console.log('crypto (portable: TEE_KEY_SECRET + master seed)');

await check('C7 before setMasterSeed: seed and deriveKey throw; hasMasterSeed false → true', async () => {
  const before = hasMasterSeed();
  const r1 = await refuses(() => getMasterSeedSync(), 'Master seed not initialized');
  const r2 = await refuses(() => deriveKey('x'), 'Master seed not initialized');
  setMasterSeed(new Uint8Array(crypto.randomBytes(32)));
  return before === false && r1 && r2 && hasMasterSeed() === true;
});

await check('C5 TEE_KEY_SECRET missing, short or not hex → refused by name', async () => {
  const msg = 'TEE_KEY_SECRET must be a 64-char hex string';
  const results = [];
  for (const bad of [undefined, 'ab'.repeat(31), 'zz'.repeat(32)]) {
    useSecret(bad);
    results.push(await refuses(() => encryptBlob(Buffer.from('x')), msg));
    results.push(await refuses(() => decryptBlob('00'.repeat(40)), msg));
  }
  useSecret(SECRET_A);
  return results.every(Boolean);
});

await check('C1 round-trip; stored layout starts with NOVG', async () => {
  useSecret(SECRET_A);
  const msg = crypto.randomBytes(1000);
  const enc = encryptBlob(msg);
  return enc.startsWith(Buffer.from('NOVG').toString('hex'))
    && Buffer.from(decryptBlob(enc)).equals(msg);
});

await check('C8 number[] input decrypts', async () => {
  useSecret(SECRET_A);
  const enc = encryptBlob(Buffer.from('array form'));
  return Buffer.from(decryptBlob([...Buffer.from(enc, 'hex')])).toString() === 'array form';
});

await check('C2 a blob does not open under a different TEE_KEY_SECRET', async () => {
  useSecret(SECRET_A);
  const enc = encryptBlob(Buffer.from('secret'));
  useSecret(SECRET_B);
  const refused = await refuses(() => decryptBlob(enc), 'Unsupported state or unable to authenticate data');
  useSecret(SECRET_A);
  return refused;
});

await check('C3 legacy CBC blobs are refused, even under the right key', async () => {
  useSecret(SECRET_A);
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(SECRET_A, 'hex'), iv);
  const ct = Buffer.concat([c.update('legacy'), c.final()]);
  return await refuses(() => decryptBlob(`${iv.toString('hex')}:${ct.toString('hex')}`), 'Legacy CBC blob refused')
    && await refuses(() => decryptBlob(Buffer.concat([iv, ct]).toString('hex')), 'missing NOVG header');
});

await check('C4 a tampered blob is refused', async () => {
  useSecret(SECRET_A);
  const raw = Buffer.from(encryptBlob(Buffer.from('integrity')), 'hex');
  raw[raw.length - 1] ^= 0x01;
  return refuses(() => decryptBlob(raw.toString('hex')), 'Unsupported state or unable to authenticate data');
});

await check('C6 deriveKey = HKDF-SHA256(master seed, salt, "nova-v1")', async () => {
  const seed = crypto.randomBytes(32);
  setMasterSeed(new Uint8Array(seed));
  const expected = Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.from('api-key:x'), Buffer.from('nova-v1'), 32));
  return Buffer.from(deriveKey('api-key:x')).equals(expected);
});

await check('C9 crypto.js no longer imports the TEE key path', async () => {
  const src = fs.readFileSync(new URL('../dist/lib/crypto.js', import.meta.url), 'utf8');
  return !src.includes('tee-keys');
});

useSecret(undefined);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

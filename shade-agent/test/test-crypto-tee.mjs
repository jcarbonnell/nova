// shade-agent/test/test-crypto-tee.mjs
//
// §5.12 item 1c-i — lib/crypto.ts reads its root secrets from the TEE keys
// (lib/tee-keys.ts), never from the environment. Proves, OFFLINE:
//   C1 encryptBlob → decryptBlob round-trips; stored layout starts with "NOVG"
//   C2 a blob does not open under a different TEE key
//   C3 legacy CBC blobs are refused (string "iv:enc" form and raw-bytes form)
//   C4 a tampered blob is refused (GCM authentication)
//   C5 before loadTeeKeys(): encrypt/decrypt/getMasterSeedSync throw, EVEN with a
//      valid-looking TEE_KEY_SECRET in the environment
//   C6 deriveKey = HKDF-SHA256(TEE masterSeed, salt, info "nova-v1")
//   C7 hasMasterSeed() false → true; setMasterSeed() is retired (throws)
//   C8 number[] input (KV's raw form) decrypts
//   C9 seed.ts: initializeMasterSeed() throws before load, returns the TEE seed
//      after, and the module no longer imports the KV layer
// Every refusal is asserted by its message.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 blobKey() returns Buffer.from(process.env.TEE_KEY_SECRET, 'hex')  → C5 (+ C1, C2, C4, C8)
//   M2 decryptBlob: drop the "Legacy CBC" refusal for "iv:enc" strings  → C3
//   M3 getMasterSeedSync returns getTeeKeys().kvEncryptionKey            → C6, C9
//   M4 seed.ts imports getBlobFromKV from './kv.js' again                → C9
//
// Build first:  npm run build
// Run:          node ./test/test-crypto-tee.mjs

import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadTeeKeys, _resetTeeKeysForTests, TEE_KEY_PATHS } from '../dist/lib/tee-keys.js';
import {
  encryptBlob, decryptBlob, deriveKey,
  hasMasterSeed, getMasterSeedSync, setMasterSeed,
} from '../dist/lib/crypto.js';
import { initializeMasterSeed } from '../dist/lib/seed.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = async (fn, needle) => {
  try { await fn(); return false; } catch (e) { return String(e?.message).includes(needle); }
};

// Two fake TEEs: same paths, different app keys.
const fakeTee = (app) => ({
  async getKey(p) { return { key: new Uint8Array(crypto.createHash('sha256').update(`${app}:${p}`).digest()) }; },
});
const keyOf = (app, p) => crypto.createHash('sha256').update(`${app}:${p}`).digest();
const useTee = async (app) => { _resetTeeKeysForTests(); await loadTeeKeys(fakeTee(app)); };

console.log('crypto (TEE keys)');

await check('C5 before loadTeeKeys(): blob crypto and seed refuse, even with TEE_KEY_SECRET set', async () => {
  _resetTeeKeysForTests();
  process.env.TEE_KEY_SECRET = 'ab'.repeat(32);
  try {
    const legacyLooking = 'NOVG'; // any input: the key lookup must fail first
    return await refuses(() => encryptBlob(Buffer.from('x')), 'TEE keys not loaded')
      && await refuses(() => decryptBlob(Buffer.from(legacyLooking).toString('hex')), 'TEE keys not loaded')
      && await refuses(() => getMasterSeedSync(), 'TEE keys not loaded');
  } finally {
    delete process.env.TEE_KEY_SECRET;
  }
});

await check('C7 hasMasterSeed() false → true after load; setMasterSeed() retired', async () => {
  _resetTeeKeysForTests();
  const before = hasMasterSeed();
  await useTee('app-A');
  const after = hasMasterSeed();
  const retired = await refuses(() => setMasterSeed(new Uint8Array(32)), 'setMasterSeed is retired');
  return before === false && after === true && retired;
});

await check('C1 round-trip; stored layout starts with NOVG', async () => {
  await useTee('app-A');
  const msg = crypto.randomBytes(1000);
  const enc = encryptBlob(msg);
  return enc.startsWith(Buffer.from('NOVG').toString('hex'))
    && Buffer.from(decryptBlob(enc)).equals(msg);
});

await check('C8 number[] input decrypts', async () => {
  await useTee('app-A');
  const enc = encryptBlob(Buffer.from('array form'));
  return Buffer.from(decryptBlob([...Buffer.from(enc, 'hex')])).toString() === 'array form';
});

await check('C2 a blob does not open under a different TEE key', async () => {
  await useTee('app-A');
  const enc = encryptBlob(Buffer.from('secret'));
  await useTee('app-B');
  return refuses(() => decryptBlob(enc), 'Unsupported state or unable to authenticate data');
});

await check('C3 legacy CBC blobs are refused (string and raw-bytes forms)', async () => {
  await useTee('app-A');
  const key = Buffer.from(keyOf('app-A', TEE_KEY_PATHS.kvEncryption));
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([c.update('legacy'), c.final()]);
  return await refuses(() => decryptBlob(`${iv.toString('hex')}:${ct.toString('hex')}`), 'Legacy CBC blob refused')
    && await refuses(() => decryptBlob(Buffer.concat([iv, ct]).toString('hex')), 'missing NOVG header');
});

await check('C4 a tampered blob is refused', async () => {
  await useTee('app-A');
  const raw = Buffer.from(encryptBlob(Buffer.from('integrity')), 'hex');
  raw[raw.length - 1] ^= 0x01;
  return refuses(() => decryptBlob(raw.toString('hex')), 'Unsupported state or unable to authenticate data');
});

await check('C6 deriveKey = HKDF-SHA256(TEE masterSeed, salt, "nova-v1")', async () => {
  await useTee('app-A');
  const seed = keyOf('app-A', TEE_KEY_PATHS.masterSeed);
  const expected = Buffer.from(crypto.hkdfSync('sha256', seed, Buffer.from('api-key:x'), Buffer.from('nova-v1'), 32));
  return Buffer.from(deriveKey('api-key:x')).equals(expected);
});

await check('C9 initializeMasterSeed(): refuses before load, TEE seed after, no KV import', async () => {
  _resetTeeKeysForTests();
  const before = await refuses(() => initializeMasterSeed(), 'TEE keys not loaded');
  await useTee('app-A');
  const seed = await initializeMasterSeed();
  const src = fs.readFileSync(new URL('../dist/lib/seed.js', import.meta.url), 'utf8');
  return before && Buffer.from(seed).equals(keyOf('app-A', TEE_KEY_PATHS.masterSeed))
    && !src.includes('kv.js');
});

_resetTeeKeysForTests();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

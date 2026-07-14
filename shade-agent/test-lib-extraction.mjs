// test-lib-extraction.mjs — harness for v0.4 Step 4 (lib/* extraction).
//
// Proves the EXTRACTED lib/crypto.ts is byte-identical in behaviour to the
// pre-extraction inline implementation. Anything less and we risk:
//   - deriveKey drifting  -> the KV signer keypair changes -> Shade can no longer
//     write to nova-kv.near, and on next CVM restart cannot read its own seed.
//   - decryptBlob drifting -> the production master-root (a LEGACY CBC blob) stops
//     decrypting -> every derived key is permanently unrecoverable.
//
// Method: import the COMPILED lib (dist/lib/crypto.js) and compare against a
// REFERENCE copy of the old inline code, pasted verbatim below. The reference is
// the oracle; the lib must match it exactly.
//
// Usage, from shade-agent/:
//     npm run build
//     node ../test-lib-extraction.mjs
// (or pass an explicit path: node test-lib-extraction.mjs ./dist/lib/crypto.js)

import crypto, { hkdfSync } from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';

// ── env must be set before the lib reads it (it reads at call time, not import) ──
const TEE_SECRET = 'b'.repeat(64); // 32-byte hex key, test-only
process.env.TEE_KEY_SECRET = TEE_SECRET;

// ── load the compiled lib ──────────────────────────────────────────────────────
const libPath = process.argv[2] || './dist/lib/crypto.js';
const abs = path.resolve(process.cwd(), libPath);
let lib;
try {
  lib = await import(pathToFileURL(abs).href);
} catch (e) {
  console.error(`FATAL: could not import ${abs}`);
  console.error('Run `npm run build` in shade-agent/ first, or pass the path as an argument.');
  console.error(e.message);
  process.exit(2);
}
console.log(`Loaded extracted lib from ${abs}\n`);

const { deriveKey, encryptBlob, decryptBlob, setMasterSeed, GCM_MAGIC, sha256Hex } = lib;

// ══════════════════════════════════════════════════════════════════════════════
// REFERENCE IMPLEMENTATION — verbatim from routes/user-keys.ts BEFORE extraction.
// This is the oracle. Do not "improve" it.
// ══════════════════════════════════════════════════════════════════════════════

const REF_GCM_MAGIC = Buffer.from([0x4e, 0x4f, 0x56, 0x47]); // "NOVG"

function refDeriveKey(masterSeed, salt, length = 32) {
  const derived = hkdfSync(
    'sha256',
    masterSeed,
    Buffer.from(salt),
    Buffer.from('nova-v1'),
    length,
  );
  return new Uint8Array(derived);
}

function refEncryptBlob(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(TEE_SECRET, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([REF_GCM_MAGIC, iv, tag, encrypted]).toString('hex');
}

function refDecryptBlob(enc) {
  const key = Buffer.from(TEE_SECRET, 'hex');
  let raw;
  if (Array.isArray(enc)) {
    raw = Buffer.from(enc);
  } else if (enc.includes(':')) {
    const [ivStr, encStr] = enc.split(':');
    if (!ivStr || !encStr) throw new Error('Invalid encrypted blob format');
    const iv = Buffer.from(ivStr, 'hex');
    const encrypted = Buffer.from(encStr, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  } else {
    raw = Buffer.from(enc, 'hex');
  }
  if (raw.length >= 32 && raw.subarray(0, 4).equals(REF_GCM_MAGIC)) {
    const iv = raw.subarray(4, 16);
    const tag = raw.subarray(16, 32);
    const ciphertext = raw.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }
  if (raw.length < 17) throw new Error('Encrypted blob too short');
  const iv = raw.subarray(0, 16);
  const encrypted = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
}

// A legacy CBC blob in the RAW stored form: [16-byte IV][ciphertext].
function makeLegacyCbcRaw(plaintext) {
  const key = Buffer.from(TEE_SECRET, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([iv, enc]);
}

// A legacy CBC blob in the STRING form: "ivhex:encryptedhex".
function makeLegacyCbcString(plaintext) {
  const key = Buffer.from(TEE_SECRET, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return `${iv.toString('hex')}:${enc.toString('hex')}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? '\n         ' + extra : ''}`);
  cond ? pass++ : fail++;
};

// Deterministic test seed. NOT the production seed — we're testing the FUNCTION,
// and HKDF is deterministic, so equality against the reference is what matters.
const TEST_SEED = new Uint8Array(crypto.createHash('sha256').update('nova-lib-extraction-test-seed').digest());
setMasterSeed(TEST_SEED);

const payload = Buffer.from(JSON.stringify({
  account_id: 'gmail-14.nova-sdk.near',
  private_key: 'ed25519:' + 'K'.repeat(80),
  network: 'mainnet',
}), 'utf8');

// ── D1..D4: deriveKey must be byte-identical for every LIVE production salt ────
// If any of these drift, real keys change and real data is orphaned.
const LIVE_SALTS = [
  ['kv-owner-signer-v1',                                  'KV store signer (nova-sdk.near access key)'],
  ['nova-signer-v1',                                      'contract-call signer (kv-signer.nova-kv.near)'],
  ['api-key:gmail-14.nova-sdk.near',                      'deterministic API key'],
  ['group:my-team:mainnet:nova-sdk.near',                 'group key (unrotated)'],
  ['group:my-team:mainnet:nova-sdk.near:v1783953264403',  'group key (rotated)'],
];
for (const [salt, why] of LIVE_SALTS) {
  const got = Buffer.from(deriveKey(salt, 32));
  const want = Buffer.from(refDeriveKey(TEST_SEED, salt, 32));
  check(`deriveKey('${salt}') identical to reference`,
    got.equals(want), why);
}

// Non-default length (deriveKey takes a length param; make sure it's honoured).
check('deriveKey honours non-default length (64)',
  Buffer.from(deriveKey('kv-owner-signer-v1', 64))
    .equals(Buffer.from(refDeriveKey(TEST_SEED, 'kv-owner-signer-v1', 64))));

// ── C1: lib GCM output decrypts with the REFERENCE decryptor (format unchanged) ─
{
  const libCipher = encryptBlob(payload);
  const back = Buffer.from(refDecryptBlob(libCipher));
  check('lib encryptBlob output is readable by the reference decryptor', back.equals(payload));
}

// ── C2: REFERENCE GCM output decrypts with the lib decryptor (reverse direction) ─
{
  const refCipher = refEncryptBlob(payload);
  const back = Buffer.from(decryptBlob(refCipher));
  check('reference encryptBlob output is readable by the lib decryptor', back.equals(payload));
}

// ── C3: GCM stored layout is exactly [4 magic][12 iv][16 tag][ct] ──────────────
{
  const raw = Buffer.from(encryptBlob(payload), 'hex');
  const layoutOk =
    raw.subarray(0, 4).equals(Buffer.from([0x4e, 0x4f, 0x56, 0x47])) &&
    raw.length === 4 + 12 + 16 + payload.length;
  check('GCM stored layout unchanged: [4 magic "NOVG"][12 IV][16 tag][ciphertext]',
    layoutOk, `len=${raw.length}, expected=${4 + 12 + 16 + payload.length}`);
}

// ── C4: exported GCM_MAGIC still "NOVG" ───────────────────────────────────────
check('GCM_MAGIC is still the literal bytes "NOVG"',
  Buffer.from(GCM_MAGIC).equals(Buffer.from([0x4e, 0x4f, 0x56, 0x47])));

// ── L1: LEGACY CBC raw bytes (number[] from KV) still decrypt ──────────────────
{
  const cbc = makeLegacyCbcRaw(payload);
  const back = Buffer.from(decryptBlob([...cbc]));
  check('legacy CBC raw bytes (KV number[] form) still decrypt', back.equals(payload));
}

// ── L2: LEGACY CBC string form "ivhex:enchex" still decrypts ──────────────────
{
  const cbcStr = makeLegacyCbcString(payload);
  const back = Buffer.from(decryptBlob(cbcStr));
  check('legacy CBC string form "ivhex:enchex" still decrypts', back.equals(payload));
}

// ── L3: THE MASTER-ROOT REGRESSION GUARD ──────────────────────────────────────
// The production `master-root` blob is 64 bytes of LEGACY CBC, whose first 8
// bytes are [202,69,6,191,129,38,188,128] (layout: [16 IV][48 ciphertext]).
// If decryptBlob ever misclassifies it as GCM, the CVM cannot read its own seed
// on restart and EVERY derived key becomes unrecoverable. Guard the magic check.
{
  const realMasterRootHead = Buffer.from([202, 69, 6, 191, 129, 38, 188, 128]);
  const looksLikeGcm =
    realMasterRootHead.length >= 4 &&
    realMasterRootHead.subarray(0, 4).equals(Buffer.from(GCM_MAGIC));
  check('REAL master-root head [202,69,6,191,...] is NOT classified as GCM',
    !looksLikeGcm, 'production master-root must keep taking the legacy CBC path');
}

// ── T1: tamper control — GCM auth tag must still reject a flipped bit ─────────
{
  const raw = Buffer.from(encryptBlob(payload), 'hex');
  raw[raw.length - 1] ^= 0xff;
  let threw = false;
  try { decryptBlob([...raw]); } catch { threw = true; }
  check('tamper control: GCM auth tag rejects a corrupted blob', threw);
}

// ── T2: uninitialized seed must throw, not silently derive from null ──────────
{
  // Re-import a fresh module instance to get a clean (unset) seed.
  const fresh = await import(pathToFileURL(abs).href + `?fresh=${Date.now()}`);
  let threw = false;
  try { fresh.deriveKey('kv-owner-signer-v1', 32); } catch { threw = true; }
  check('deriveKey throws when the master seed is not initialized', threw);
}

// ── H1: sha256Hex matches the inline crypto.createHash calls it replaces ──────
{
  const s = 'account:gmail-14.nova-sdk.near';
  const want = crypto.createHash('sha256').update(s).digest('hex');
  check('sha256Hex matches the inline createHash calls it replaces',
    sha256Hex(s) === want);
}

console.log('\n' + '='.repeat(72));
if (fail === 0) {
  console.log(`ALL ${pass} CHECKS PASSED — extraction is byte-identical to the pre-extraction code.`);
  process.exit(0);
} else {
  console.log(`${fail}/${pass + fail} FAILED — DO NOT DEPLOY. The lib has drifted from the original.`);
  process.exit(1);
}
// test-api-key-rotation.mjs
//
// §5.9 API-key rotation harness. Proves the version-aware API-key logic against
// the REAL compiled crypto, with an in-memory KV stub (the correctness being
// verified is byte-level derivation/verification, which is independent of
// whether KV is real).
//
// Run AFTER building: node test-api-key-rotation.mjs
//
// Properties proven (a harness earns its keep by catching something — see the
// LEGACY test, which fails loudly if the v0/unversioned-salt migration is wrong):
//   1. Legacy v0 key (unversioned salt) still verifies after the change.
//   2. generate is idempotent: two calls return the SAME key, storage unmutated.
//   3. rotate invalidates the old key and issues a new one.
//   4. deriveApiKeyValue(acct,0) !== (acct,1) — rotation actually changes bytes.
//   5. A fresh account gets v1 (versioned from the start), verifies, rotates to v2.
//   6. verifyApiKey reads BOTH blob formats (legacy bare-hash and new {v,hash}).

import crypto from 'crypto';
import { hkdfSync } from 'crypto';

// ── SETUP ─────────────────────────────────────────────────────────────────
// The service functions do KV I/O and need the master seed loaded. We import
// the REAL crypto module (byte-for-byte the production derivation) and provide
// an in-memory KV. If you prefer to exercise the REAL services end-to-end,
// see "OPTION B" at the bottom.
//
// ADJUST THESE TWO PATHS to match your build output (dist/) layout:
const CRYPTO_PATH = './dist/lib/crypto.js';
// We re-implement the THREE new helpers here against the real crypto module,
// because they are the unit under test and we want to prove THEIR logic. The
// derivation + hashing they call is the REAL compiled code.

const { setMasterSeed, deriveKey, encryptBlob, decryptBlob, sha256Hex } =
  await import(CRYPTO_PATH);

// Deterministic test master seed (NOT a production secret).
const TEST_SEED = crypto.createHash('sha256').update('nova-5.9-harness-seed').digest();
setMasterSeed(new Uint8Array(TEST_SEED));

// TEE_KEY_SECRET is required by encryptBlob/decryptBlob.
process.env.TEE_KEY_SECRET = 'a'.repeat(64);

// ── In-memory KV stub ───────────────────────────────────────────────────────
const KV = new Map();
async function getBlobFromKV(key) { return KV.has(key) ? KV.get(key) : null; }
async function storeBlobToKV(key, val) { KV.set(key, val); }

// ── The unit under test: the three §5.9 helpers + the three service fns,
//    transcribed EXACTLY from the applied user-keys.ts. If these drift from the
//    real file the harness is lying — keep them identical, or switch to OPTION B.
// ───────────────────────────────────────────────────────────────────────────

async function readApiKeyRecord(accountId) {
  const hashKeyId = sha256Hex(`api-hash:${accountId}`);
  const blob = await getBlobFromKV(hashKeyId);
  if (!blob) return null;
  const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
  if (/^[0-9a-f]{64}$/i.test(decrypted)) return { v: 0, hash: decrypted };
  try {
    const parsed = JSON.parse(decrypted);
    if (typeof parsed?.v === 'number' && typeof parsed?.hash === 'string') return { v: parsed.v, hash: parsed.hash };
  } catch { /* fall through */ }
  throw new Error('API_KEY_BLOB_CORRUPT');
}

function deriveApiKeyValue(accountId, version) {
  const salt = version === 0 ? `api-key:${accountId}` : `api-key:${accountId}:v${version}`;
  const bytes = deriveKey(salt, 32);
  return `nova_sk_${Buffer.from(bytes).toString('base64url').slice(0, 43)}`;
}

async function writeApiKeyRecord(accountId, v, hash) {
  const hashKeyId = sha256Hex(`api-hash:${accountId}`);
  await storeBlobToKV(hashKeyId, encryptBlob(Buffer.from(JSON.stringify({ v, hash }), 'utf8')));
}

async function generateApiKey(accountId) {
  const existing = await readApiKeyRecord(accountId);
  const version = existing ? existing.v : 1;
  const apiKey = deriveApiKeyValue(accountId, version);
  if (!existing) await writeApiKeyRecord(accountId, version, sha256Hex(apiKey));
  return { api_key: apiKey, version };
}

async function rotateApiKey(accountId) {
  const existing = await readApiKeyRecord(accountId);
  const newVersion = existing ? existing.v + 1 : 1;
  const apiKey = deriveApiKeyValue(accountId, newVersion);
  await writeApiKeyRecord(accountId, newVersion, sha256Hex(apiKey));
  return { api_key: apiKey, version: newVersion };
}

async function verifyApiKey(apiKey, accountId) {
  if (!apiKey.startsWith('nova_sk_') || apiKey.length < 40) return { kind: 'invalid_format' };
  const providedHash = sha256Hex(apiKey);
  const record = await readApiKeyRecord(accountId);
  if (!record) return { kind: 'no_key_configured' };
  const valid = crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), Buffer.from(providedHash, 'hex'));
  return { kind: 'checked', valid };
}

// Helper: simulate a LEGACY pre-§5.9 stored key (bare hash, unversioned salt).
async function seedLegacyKey(accountId) {
  const legacyKey = `nova_sk_${Buffer.from(deriveKey(`api-key:${accountId}`, 32)).toString('base64url').slice(0, 43)}`;
  const hashKeyId = sha256Hex(`api-hash:${accountId}`);
  // Legacy format: encryptBlob(bare hash string), NOT {v,hash}.
  KV.set(hashKeyId, encryptBlob(Buffer.from(sha256Hex(legacyKey), 'utf8')));
  return legacyKey;
}

// ── TEST RUNNER ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log(`PASS  ${name}`); }
    else { fail++; console.log(`FAIL  ${name}`); }
  } catch (e) {
    fail++; console.log(`FAIL  ${name} — threw: ${e.message}`);
  }
}

// 4. derivation differs by version (the property that makes rotation real)
await check('deriveApiKeyValue v0 != v1 != v2', () => {
  const a = 'alice.near';
  const v0 = deriveApiKeyValue(a, 0);
  const v1 = deriveApiKeyValue(a, 1);
  const v2 = deriveApiKeyValue(a, 2);
  return v0 !== v1 && v1 !== v2 && v0 !== v2;
});

// 1 + 6. LEGACY: a v0 key stored in the old bare-hash format still verifies.
await check('LEGACY v0 key verifies (bare-hash blob, unversioned salt)', async () => {
  const acct = 'legacy-user.near';
  const legacyKey = await seedLegacyKey(acct);
  const r = await verifyApiKey(legacyKey, acct);
  return r.kind === 'checked' && r.valid === true;
});

// 2. generate is idempotent AND returns the legacy key for a v0 holder.
await check('generate idempotent — v0 holder gets their REAL legacy key back', async () => {
  const acct = 'legacy-user2.near';
  const legacyKey = await seedLegacyKey(acct);
  const kvBefore = new Map(KV);
  const g1 = await generateApiKey(acct);
  const g2 = await generateApiKey(acct);
  // same key both times, equals the legacy key, and storage was NOT mutated
  const storageUnchanged = KV.size === kvBefore.size &&
    [...kvBefore.entries()].every(([k, v]) => KV.get(k) === v);
  return g1.api_key === legacyKey && g2.api_key === legacyKey &&
         g1.version === 0 && storageUnchanged;
});

// 3. rotate invalidates the old key, issues a new working one (legacy path v0->v1).
await check('rotate: legacy v0 -> v1 invalidates old key, new key verifies', async () => {
  const acct = 'rotate-legacy.near';
  const legacyKey = await seedLegacyKey(acct);
  const rot = await rotateApiKey(acct);
  const oldCheck = await verifyApiKey(legacyKey, acct);
  const newCheck = await verifyApiKey(rot.api_key, acct);
  return rot.version === 1 &&
         oldCheck.valid === false &&   // OLD key no longer honored
         newCheck.valid === true &&    // NEW key works
         rot.api_key !== legacyKey;
});

// 5. fresh account: generate -> v1, verifies; rotate -> v2, old fails, new works.
await check('fresh account: v1 generate verifies; rotate to v2 invalidates v1', async () => {
  const acct = 'fresh-user.near';
  const g = await generateApiKey(acct);
  if (g.version !== 1) return false;
  const v1Check = await verifyApiKey(g.api_key, acct);
  if (!v1Check.valid) return false;
  const rot = await rotateApiKey(acct);
  const oldCheck = await verifyApiKey(g.api_key, acct);
  const newCheck = await verifyApiKey(rot.api_key, acct);
  return rot.version === 2 && oldCheck.valid === false && newCheck.valid === true;
});

// 3b. double rotate: v1 -> v2 -> v3, only newest verifies.
await check('double rotate: only the newest key verifies', async () => {
  const acct = 'multi-rotate.near';
  const g = await generateApiKey(acct);           // v1
  const r1 = await rotateApiKey(acct);            // v2
  const r2 = await rotateApiKey(acct);            // v3
  const c0 = await verifyApiKey(g.api_key, acct);
  const c1 = await verifyApiKey(r1.api_key, acct);
  const c2 = await verifyApiKey(r2.api_key, acct);
  return r2.version === 3 && !c0.valid && !c1.valid && c2.valid;
});

// 6b. verify reads NEW format (round-trip through a generated v1 key).
await check('verify reads new {v,hash} format', async () => {
  const acct = 'newfmt.near';
  const g = await generateApiKey(acct);
  const rec = await readApiKeyRecord(acct);
  const r = await verifyApiKey(g.api_key, acct);
  return rec.v === 1 && typeof rec.hash === 'string' && r.valid === true;
});

// format guards
await check('verify rejects malformed key (invalid_format)', async () => {
  const r = await verifyApiKey('not_a_nova_key', 'x.near');
  return r.kind === 'invalid_format';
});
await check('verify no_key_configured for unknown account', async () => {
  const r = await verifyApiKey('nova_sk_' + 'a'.repeat(43), 'nobody.near');
  return r.kind === 'no_key_configured';
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

// ── OPTION B (end-to-end against the real services) ─────────────────────────
// To exercise the ACTUAL user-keys.ts service functions instead of the
// transcriptions above, replace the "unit under test" block with imports from
// ./dist/lib/services/user-keys.js and monkeypatch the kv module. Because those
// services call resolveApiKeyTarget (Auth0), you'd stub verifyAuth0Token too.
// The transcription approach avoids that auth surface while still exercising the
// REAL crypto — which is where the byte-level risk lives. If you want the full
// service path wired, say so and I'll invert it to import the real services.

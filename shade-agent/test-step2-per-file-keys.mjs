// nova/tests/step2-per-file-keys.mjs
// Step 2 harness — per-file key hierarchy (§5.1), against the REAL compiled lib.
//
// OFFLINE (no network, fixed regression seed):
//   gcmWrap/gcmUnwrap round-trip; wrong-key/wrong-version rejection (auth tag);
//   tombstone round-trips through encryptBlob and is distinguishable from a
//   real record; group-key derivation UNCHANGED (golden vectors — the regression
//   proof that adding file-key code didn't perturb the group-key path).
// ONLINE (real seed + a group where STEP2_ACCOUNT is authorized):
//   generateFileKey → getFileKey round-trip; version pinning across a rotation;
//   tombstoneFileKey → getFileKey throws FILE_DELETED.
//   Set STEP2_GROUP and STEP2_ACCOUNT to enable; skipped otherwise.
//
// Build first (shade-agent): npm run build ;  Run: node nova/tests/step2-per-file-keys.mjs

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  gcmWrap, gcmUnwrap, deriveKey, encryptBlob, decryptBlob, setMasterSeed, sha256Hex,
} from './dist/lib/crypto.js';
import {
  generateFileKey, getFileKey, tombstoneFileKey, _FILE_TOMBSTONE,
} from './dist/lib/services/key-management.js';

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`  \u2713 ${n}`); };
const bad = (n, e) => { fail++; console.log(`  \u2717 ${n}\n      ${e?.message || e}`); };
const test      = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const testAsync = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const hex = (b) => Buffer.from(b).toString('hex');

// groupSalt is not exported; replicate it verbatim for the golden-vector check.
const groupSalt = (g, net, c, v) => v ? `group:${g}:${net}:${c}:v${v}` : `group:${g}:${net}:${c}`;

console.log('\nStep 2 — per-file keys harness\n');

// ── Fixed regression seed → deterministic derivation vectors ──
const REGRESSION_SEED = crypto.createHash('sha256').update('nova-step2-regression-seed').digest();
setMasterSeed(new Uint8Array(REGRESSION_SEED));
process.env.TEE_KEY_SECRET = process.env.TEE_KEY_SECRET || 'a'.repeat(64);

console.log('OFFLINE:');

// 1. group-key derivation UNCHANGED — golden vectors computed independently.
//    Any change to groupSalt format or deriveKey's HKDF params breaks these.
test('group-key derivation (base) matches golden vector', () => {
  assert.equal(hex(deriveKey(groupSalt('g', 'mainnet', 'c'), 32)),
    '6d294669c3a70b35ef62ce52be354f23b9ba9614e5f8c6f3aa6b98b60f2bb77a');
});
test('group-key derivation (v7) matches golden vector', () => {
  assert.equal(hex(deriveKey(groupSalt('g', 'mainnet', 'c', '7'), 32)),
    '49ba6b8fc9842ba7765b0e321ddb9b2c5eae1aa0b7d955ed9c4c875de7b02741');
});
test('deriveKey is deterministic', () => {
  assert.equal(hex(deriveKey('any-salt', 32)), hex(deriveKey('any-salt', 32)));
});

// 2. gcmWrap / gcmUnwrap
test('gcmWrap → gcmUnwrap round-trips', () => {
  const key = crypto.randomBytes(32), data = crypto.randomBytes(32);
  assert.ok(Buffer.from(gcmUnwrap(gcmWrap(data, key), key)).equals(data));
});
test('gcmUnwrap with wrong key throws (auth tag)', () => {
  const data = crypto.randomBytes(32);
  const w = gcmWrap(data, crypto.randomBytes(32));
  assert.throws(() => gcmUnwrap(w, crypto.randomBytes(32)));
});
test('version pinning: unwrap needs the SAME group-key version', () => {
  const gkBase = deriveKey(groupSalt('g', 'mainnet', 'c'), 32);
  const gkV7   = deriveKey(groupSalt('g', 'mainnet', 'c', '7'), 32);
  const fileKey = crypto.randomBytes(32);
  const wrapped = gcmWrap(fileKey, gkBase);
  assert.ok(Buffer.from(gcmUnwrap(wrapped, gkBase)).equals(fileKey));   // right version ok
  assert.throws(() => gcmUnwrap(wrapped, gkV7));                        // wrong version fails
});
test('gcmWrap rejects non-32-byte keys', () => {
  assert.throws(() => gcmWrap(crypto.randomBytes(32), crypto.randomBytes(16)));
});

// 3. tombstone: round-trips through the TEE layer and is distinguishable
test('tombstone survives encryptBlob/decryptBlob and matches sentinel', () => {
  assert.ok(Buffer.from(decryptBlob(encryptBlob(_FILE_TOMBSTONE))).equals(_FILE_TOMBSTONE));
});
test('a real wrapped-key record is NOT the tombstone', () => {
  const rec = Buffer.from(JSON.stringify({ v: null, w: gcmWrap(crypto.randomBytes(32), crypto.randomBytes(32)) }), 'utf8');
  assert.ok(!Buffer.from(decryptBlob(encryptBlob(rec))).equals(_FILE_TOMBSTONE));
});

// ── ONLINE ───────────────────────────────────────────────────────────────
const GROUP = process.env.STEP2_GROUP;
const ACCOUNT = process.env.STEP2_ACCOUNT;         // must be is_authorized in GROUP
const CONTRACT = process.env.STEP2_CONTRACT;       // optional; defaults mainnet nova-sdk.near

if (GROUP && ACCOUNT) {
  console.log('\nONLINE (real seed + network):');
  let seedOk = true;
  try {
    const { initializeMasterSeed } = await import('./dist/lib/seed.js');
    await initializeMasterSeed(); // overrides the regression seed with the real one
  } catch (e) {
    seedOk = false;
    console.log(`  … skipped (real seed unavailable: ${e?.message || e})`);
  }

  if (seedOk) {
    const base = { group_id: GROUP, account_id: ACCOUNT, contract_id: CONTRACT };
    const fileRef = 'step2-' + crypto.randomUUID();

    await testAsync('generateFileKey → getFileKey returns the same key', async () => {
      const gen = await generateFileKey({ ...base, file_ref: fileRef });
      const got = await getFileKey({ ...base, file_ref: fileRef });
      assert.equal(got.file_key, gen.file_key);
      assert.equal(got.version, gen.version);
    });

    await testAsync('tombstoneFileKey → getFileKey throws FILE_DELETED', async () => {
      await tombstoneFileKey(GROUP, fileRef);
      await assert.rejects(getFileKey({ ...base, file_ref: fileRef }), /FILE_DELETED|deleted/i);
    });
  }
} else {
  console.log('\nONLINE: skipped (set STEP2_GROUP + STEP2_ACCOUNT to a group where the account is authorized).');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

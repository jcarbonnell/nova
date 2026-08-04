// nova/tests/fastfs-step1.mjs
// Step 1 harness — proves lib/fastfs.ts against the REAL compiled module, and
// that extracting signAndBroadcastFunctionCall did NOT break KV writes.
//
// OFFLINE (no network): borsh vectors, path determinism, location round-trip,
//   finalization tripwire truth table.
// ONLINE (mainnet, real signer — needs Shade env: TEE_KEY_SECRET + KV access):
//   KV write+read still works (regression), FastFS upload→serve→decrypt→delete→gone.
//
// Build first (in shade-agent):  npm run build     # tsc -> dist
// Run:                           node nova/tests/fastfs-step1.mjs
// Signs as nova-sdk.near (kv-owner-signer-v1), same as the spike; sub-cent.

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  upload, remove, retrieve,
  deriveFastfsPathPrefix, newRelativePath,
  encodeFastfsLocation, parseFastfsLocation,
  assertFastfsEnvelopeFinalized,
  borshFastfsUpload, borshFastfsDelete,
} from '../shade-agent/dist/lib/fastfs.js';
import { storeBlobToKV, getBlobFromKV } from './dist/lib/kv.js';
import { encryptBlob, decryptBlob, setMasterSeed } from './dist/lib/crypto.js';

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`  \u2713 ${n}`); };
const bad = (n, e) => { fail++; console.log(`  \u2717 ${n}\n      ${e?.message || e}`); };
const test      = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };
const testAsync = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };
const hex = (b) => Buffer.from(b).toString('hex');

// throwaway GCM — mirrors client-side encryption; FastFS only sees ciphertext
function gcmEncrypt(pt, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function gcmDecrypt(blob, key) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function pollServe(loc, expectBytes, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (Buffer.from(await retrieve(loc)).equals(expectBytes)) return Date.now() - t0; } catch {}
    await sleep(2_000);
  }
  throw new Error(`gateway did not serve within ${timeoutMs}ms`);
}
async function pollGone(loc, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await retrieve(loc); } catch { return Date.now() - t0; }
    await sleep(2_000);
  }
  throw new Error(`gateway still serving after ${timeoutMs}ms`);
}

console.log('\nFastFS Step 1 harness\n');

// ── Seed: prefer the REAL seed (enables ONLINE); else a test seed (OFFLINE only).
//    borsh vectors + tripwire are seed-independent; path determinism holds for any seed.
let haveRealSeed = false;
try {
  const { initializeMasterSeed } = await import('./dist/lib/seed.js');
  await initializeMasterSeed();
  haveRealSeed = true;
  console.log('seed: real master seed loaded (ONLINE enabled)\n');
} catch (e) {
  setMasterSeed(crypto.createHash('sha256').update('fastfs-step1-test-seed').digest());
  console.log(`seed: test seed (ONLINE skipped: ${e?.message || e})\n`);
}

// ══ OFFLINE ════════════════════════════════════════════════════════════════
console.log('OFFLINE:');

test('borshFastfsDelete matches spike vector', () => {
  assert.equal(hex(borshFastfsDelete('nova-spike/abc')),
    '000e0000006e6f76612d7370696b652f61626300');
});
test('borshFastfsUpload matches spike vector', () => {
  assert.equal(hex(borshFastfsUpload('nova-spike/abc', 'application/octet-stream', Uint8Array.from([1, 2, 3, 4]))),
    '00' + '0e0000006e6f76612d7370696b652f616263' + '01' +
    '18000000' + Buffer.from('application/octet-stream').toString('hex') +
    '04000000' + '01020304');
});

test('path prefix is deterministic per group', () => {
  assert.equal(deriveFastfsPathPrefix('grp-1'), deriveFastfsPathPrefix('grp-1'));
});
test('path prefix differs across groups', () => {
  assert.notEqual(deriveFastfsPathPrefix('grp-1'), deriveFastfsPathPrefix('grp-2'));
});
test('path prefix is 64-hex (sha256)', () => {
  assert.match(deriveFastfsPathPrefix('grp-1'), /^[0-9a-f]{64}$/);
});
test('newRelativePath sits under the group prefix', () => {
  assert.ok(newRelativePath('grp-1').startsWith(deriveFastfsPathPrefix('grp-1') + '/'));
});

test('encode/parse location round-trips (relativePath keeps its slash)', () => {
  const rel = 'a'.repeat(64) + '/' + crypto.randomUUID();
  const p = parseFastfsLocation(encodeFastfsLocation(rel));
  assert.equal(p.relativePath, rel);
  assert.equal(p.predecessor, 'nova-sdk.near');
  assert.equal(p.receiver, 'fastfs.near');
});

test('tripwire: no tx hash → throws', () => {
  assert.throws(() => assertFastfsEnvelopeFinalized({ status: {} }), /NOT_FINALIZED|not finalize/);
});
test('tripwire: CodeDoesNotExist at receiver → passes', () => {
  assertFastfsEnvelopeFinalized({
    transaction: { hash: 'h' },
    status: { Failure: { ActionError: { kind: { FunctionCallError: { CompilationError: { CodeDoesNotExist: { account_id: 'fastfs.near' } } } } } } },
  });
});
test('tripwire: other failure → throws', () => {
  assert.throws(() => assertFastfsEnvelopeFinalized({
    transaction: { hash: 'h' },
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'boom' } } } } },
  }), /UNEXPECTED_STATUS|unexpected/);
});
test('tripwire: executed success → passes', () => {
  assertFastfsEnvelopeFinalized({ transaction: { hash: 'h' }, status: { SuccessValue: '' } });
});

// ══ ONLINE ═════════════════════════════════════════════════════════════════
if (haveRealSeed) {
  console.log('\nONLINE (real signer, mainnet):');

  // Regression: refactored storeBlobToKV still writes+reads (single reused junk key).
  await testAsync('KV write+read round-trips through refactored storeBlobToKV', async () => {
    const probe = crypto.randomBytes(48);
    await storeBlobToKV('_fastfs_step1_kv_probe', encryptBlob(probe));
    const back = await getBlobFromKV('_fastfs_step1_kv_probe');
    assert.ok(back, 'blob not found after store');
    assert.deepEqual(Buffer.from(decryptBlob(back)), probe);
  });

  // Full FastFS round-trip through the real module.
  await testAsync('FastFS upload → serve → decrypt → delete → gone', async () => {
    const key = crypto.randomBytes(32);
    const plain = crypto.randomBytes(20_000);
    const ct = Buffer.from(gcmEncrypt(plain, key));
    const group = 'fastfs-step1-' + crypto.randomUUID();

    const loc = await upload(new Uint8Array(ct), group);
    assert.equal(loc.backend, 'fastfs');

    const serveMs = await pollServe(loc, ct);
    const got = Buffer.from(await retrieve(loc));
    assert.ok(got.equals(ct), 'ciphertext mismatch on retrieve');
    assert.ok(gcmDecrypt(got, key).equals(plain), 'plaintext mismatch after decrypt');

    await remove(loc);
    const goneMs = await pollGone(loc);
    console.log(`      serve=${serveMs}ms gone=${goneMs}ms loc=${loc.location}`);
  });
} else {
  console.log('\nONLINE: skipped (run in the Shade env with TEE_KEY_SECRET + KV access).');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

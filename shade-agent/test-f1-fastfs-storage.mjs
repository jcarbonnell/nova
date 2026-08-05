// nova/tests/f1-fastfs-storage.mjs
// F1 harness — the integration-flip storage path, against the REAL compiled
// Shade service. Proves the whole loop on mainnet:
//   prepareFileUpload → encrypt with the returned file key → finalizeFileUpload
//   (real __fastdata_fastfs envelope + real KV file-meta write) → poll the
//   gateway → retrieveFile → decrypt byte-identical → tombstoneFileKey →
//   retrieveFile throws FILE_DELETED.
//
// Runs as a REAL MEMBER of the group (the exact is_authorized path MCP uses):
//   caller  = gmail-14.nova-sdk.near  (account_id, member of engine-test-evt)
//   group   = engine-test-evt
//   envelope signer = nova-sdk.near   (automatic, via the kv-owner-signer-v1 key)
// The file_ref is a fresh random uuid per run, so the tombstone shreds ONLY this
// harness's throwaway file — never any real engine-test-evt data.
//
// Needs the Shade env (TEE_KEY_SECRET + KV access + the kv-owner-signer-v1 access
// key on nova-sdk.near), same as the Step 1/2 online runs. Build first:
//   (shade-agent) npm run build
// Run:
//   STEP_GROUP=engine-test-evt STEP_ACCOUNT=gmail-14.nova-sdk.near \
//     node nova/tests/f1-fastfs-storage.mjs

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  prepareFileUpload, finalizeFileUpload, retrieveFile,
} from '../shade-agent/dist/lib/services/fastfs-storage.js';
import { tombstoneFileKey } from './dist/lib/services/key-management.js';

const GROUP = process.env.STEP_GROUP || 'engine-test-evt';
const ACCOUNT = process.env.STEP_ACCOUNT || 'gmail-14.nova-sdk.near';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  \u2713 ${n}`); };
const bad = (n, e) => { fail++; console.log(`  \u2717 ${n}\n      ${e?.message || e}`); };
const test = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

// v0 wire codec (IV||ct||tag) — the exact layout the SDK's encryptV0 uses, so the
// round-trip proves the real ciphertext shape, not a lookalike.
function gcmEncrypt(data, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}
function gcmDecrypt(b64, keyB64) {
  const key = Buffer.from(keyB64, 'base64');
  const raw = Buffer.from(b64, 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(raw.length - 16), ct = raw.subarray(12, raw.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// A FileFormatV1 shaped like the SDK's encodeFile output — proves the real
// metadata store/return path.
const makeFormat = (size) => ({
  version: 1, backend: 'fastfs', encryption: 'AES-256-GCM', wrapping: 'AES-GCM-keywrap',
  original_size: size, content_type: 'application/octet-stream',
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\nF1 — FastFS storage service harness (mainnet)\n');
console.log(`  group=${GROUP}  caller=${ACCOUNT}\n`);

// Load the real master seed (needed for path derivation + signer). If it can't
// load, we're not in the Shade env — fail loudly rather than skip silently.
if (!/^[0-9a-fA-F]{64}$/.test(process.env.TEE_KEY_SECRET || '')) {
  console.log('  ✗ TEE_KEY_SECRET (64-hex) not set — source the real Shade env first.');
  console.log('    F1 writes real KV blobs, so it needs the PRODUCTION key, not a throwaway.\n');
  process.exit(1);
}
try {
  const { initializeMasterSeed } = await import('../shade-agent/dist/lib/seed.js');
  await initializeMasterSeed();
} catch (e) {
  console.log(`  ✗ master seed load failed (KV/env): ${e?.message || e}\n`);
  process.exit(1);
}

const base = { group_id: GROUP, account_id: ACCOUNT };
const plaintext = crypto.randomBytes(20_000); // ~20 KB throwaway payload
let fileRef, location;

await test('prepareFileUpload authorizes the member and returns a file key + ref', async () => {
  const prep = await prepareFileUpload({ ...base });
  assert.ok(prep.file_key, 'no file_key');
  assert.ok(prep.file_ref && prep.file_ref.includes('/'), 'file_ref should be prefix/uuid');
  assert.ok(Buffer.from(prep.file_key, 'base64').length === 32, 'file key must be 32 bytes');
  fileRef = prep.file_ref;
  // stash the key for the next steps
  base._file_key = prep.file_key;
});

await test('finalizeFileUpload signs the envelope and returns a FastFS location', async () => {
  const encrypted_b64 = gcmEncrypt(plaintext, base._file_key);
  console.log(`      [debug] ciphertext b64 len=${encrypted_b64.length}, file_ref len=${fileRef.length}`);
  const fin = await finalizeFileUpload({
    group_id: GROUP, file_ref: fileRef, encrypted_b64, format: makeFormat(plaintext.length),
  });
  assert.equal(fin.backend, 'fastfs');
  assert.ok(fin.location.endsWith(fileRef), 'location should encode the file_ref');
  location = fin.location;
});

await test('gateway serves → retrieveFile decrypts byte-identical + returns format', async () => {
  // poll the gateway for propagation (~2-3s), through the real retrieve path
  let got, lastErr;
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    try {
      const r = await retrieveFile({ ...base, location });
      // retrieveFile can succeed before the file-meta write reaches `final`
      // (format comes back null). Not a service bug — meta is a non-security
      // decode hint, and real uploads/downloads are seconds-to-minutes apart, not
      // ~1s. Keep polling until the format materialises.
      if (r.format && r.format.version === 1) { got = r; break; }
      lastErr = new Error('format not final yet');
    } catch (e) { lastErr = e; }
    await sleep(2_000);
  }
  if (!got) throw new Error(`retrieve never returned final format: ${lastErr?.message || lastErr}`);

  assert.equal(got.file_key, base._file_key, 'retrieve must return the same file key');
  assert.ok(gcmDecrypt(got.encrypted_b64, got.file_key).equals(plaintext), 'plaintext mismatch');
  assert.equal(got.format?.version, 1, 'format v1 not returned');
  assert.equal(got.format?.original_size, plaintext.length, 'format original_size mismatch');
});

await test('tombstoneFileKey → retrieveFile throws FILE_DELETED (crypto-shred)', async () => {
  await tombstoneFileKey(GROUP, fileRef);
  await assert.rejects(
    retrieveFile({ ...base, location }),
    (e) => /FILE_DELETED|deleted/i.test(e?.code || e?.message || String(e)),
    'retrieve after shred must reject with FILE_DELETED',
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? '' : `  (shredded throwaway file_ref ${fileRef?.slice(-12)} — no real data touched)\n`);
process.exit(fail ? 1 : 0);

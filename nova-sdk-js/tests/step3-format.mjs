// nova-sdk-js/test/step3-format.mjs
// Step 3 harness — file-format versioning (§5.3), against the REAL compiled SDK.
//
// Proves: v0 codec is frozen (round-trips + decodes the exact IV||ct||tag
// layout); v1 round-trips uncompressed AND deflate-compressed; deflate shrinks
// compressible data; the dispatcher routes absent/v0/v1 correctly and REJECTS
// unknown versions and brotli (deferred) rather than mis-decoding.
//
// Build the SDK first, then:  node nova-sdk-js/test/step3-format.mjs
// Imports from the package entry (index re-exports encodeFile/decodeFile/v0).

import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import {
  encodeFile, decodeFile, encryptV0, decryptV0,
} from '../dist/index.js';

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`  \u2713 ${n}`); };
const bad = (n, e) => { fail++; console.log(`  \u2717 ${n}\n      ${e?.message || e}`); };
const test = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const key = crypto.randomBytes(32).toString('base64');
const data = Buffer.from('NOVA file body '.repeat(500)); // compressible

console.log('\nStep 3 — file-format versioning harness\n');

// ── v0 frozen ──
await test('v0 round-trips (encryptV0 → decryptV0)', async () => {
  assert.ok((await decryptV0(await encryptV0(data, key), key)).equals(data));
});
await test('v0 decodes the exact IV||ct||tag layout', async () => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const e = Buffer.concat([c.update(data), c.final()]);
  const manual = Buffer.concat([iv, e, c.getAuthTag()]).toString('base64');
  assert.ok((await decryptV0(manual, key)).equals(data));
});

// ── v1 ──
await test('v1 uncompressed round-trips', async () => {
  const { bytes_b64, format } = await encodeFile(data, key);
  assert.ok((await decodeFile(bytes_b64, key, format)).equals(data));
});
await test('v1 metadata fields are correct', async () => {
  const { format } = await encodeFile(data, key, { content_type: 'text/plain' });
  assert.equal(format.version, 1);
  assert.equal(format.encryption, 'AES-256-GCM');
  assert.equal(format.wrapping, 'AES-GCM-keywrap');
  assert.equal(format.original_size, data.length);
  assert.equal(format.content_type, 'text/plain');
  assert.ok(!('compression' in format));
});
await test('v1 deflate round-trips and records the algo', async () => {
  const { bytes_b64, format } = await encodeFile(data, key, { compression: 'deflate' });
  assert.equal(format.compression, 'deflate');
  assert.ok((await decodeFile(bytes_b64, key, format)).equals(data));
});
await test('deflate shrinks compressible data', async () => {
  const plain = (await encodeFile(data, key)).bytes_b64;
  const comp = (await encodeFile(data, key, { compression: 'deflate' })).bytes_b64;
  assert.ok(comp.length < plain.length, `expected ${comp.length} < ${plain.length}`);
});

// ── dispatch ──
await test('absent format ⇒ v0 path', async () => {
  const b = await encryptV0(data, key);
  assert.ok((await decodeFile(b, key)).equals(data));
});
await test('explicit {version:0} ⇒ v0 path', async () => {
  const b = await encryptV0(data, key);
  assert.ok((await decodeFile(b, key, { version: 0 })).equals(data));
});
await test('unknown version throws (no silent mis-decode)', async () => {
  const b = await encryptV0(data, key);
  await assert.rejects(decodeFile(b, key, { version: 2 }), /Unsupported file format version/);
});
await test('brotli is rejected (deferred)', async () => {
  await assert.rejects(encodeFile(data, key, { compression: 'brotli' }), /not implemented|brotli/i);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

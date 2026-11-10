// shade-agent/scripts/seed-ceremony.mjs
//
// §5.12 S1b — the operator's master-seed procedure (roadmap §5.12, the March 2026
// procedure, now AES-256-GCM). Run ONCE, offline from Shade, on the operator's
// machine, from shade-agent/ after `npm run build`.
//
// Inputs (environment only, never arguments; set them with `read -rs`):
//   TEE_KEY_SECRET   64 hex chars — the new root secret (also entered in Phala)
//   MASTER_SEED      64 hex chars — the new random master seed
//   KV_CONTRACT_ID   the KV account that will hold master-root (e.g. nova-kv-2.near)
//
// It uses Shade's OWN compiled crypto (dist/lib/crypto.js, dist/lib/kv.js), so the
// blob is exactly what Shade decrypts and the keys are exactly what Shade signs with.
//
// Outputs — NOTHING SECRET is printed or written:
//   • master-root.args.json: {"key":"master-root","encrypted_blob":[…]}, the args
//     for the operator's `store` call (ciphertext only)
//   • fingerprints of TEE_KEY_SECRET and MASTER_SEED, exactly `printf %s "$X" | shasum -a 256 | cut -c1-12`, to compare
//     with the offline backup and, later, with Phala and Shade
//   • the three signer public keys to add to nova-sdk.near as function-call keys
// Before writing anything it decrypts its own blob with Shade's decryptBlob and
// checks it returns the seed.
//
// Harness: test/test-seed-ceremony.mjs.

import fs from 'node:fs';
import crypto from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/i;
const OUT = 'master-root.args.json';

function fail(message) {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}
const fingerprint = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

const secret = process.env.TEE_KEY_SECRET;
const seedHex = process.env.MASTER_SEED;
const kvContract = process.env.KV_CONTRACT_ID;

if (!secret || !HEX64.test(secret)) fail('TEE_KEY_SECRET must be set to 64 hex chars');
if (!seedHex || !HEX64.test(seedHex)) fail('MASTER_SEED must be set to 64 hex chars');
if (secret.toLowerCase() === seedHex.toLowerCase()) fail('MASTER_SEED must differ from TEE_KEY_SECRET');
if (!kvContract) fail('KV_CONTRACT_ID must be set (the KV account that will hold master-root)');
if (fs.existsSync(OUT)) fail(`${OUT} already exists; move it away first (never overwrite a previous run)`);

const { encryptBlob, decryptBlob, setMasterSeed } = await import('../dist/lib/crypto.js');
const { signerPublicKeyFor } = await import('../dist/lib/kv.js');
const { FASTFS_RECEIVER } = await import('../dist/lib/fastfs.js');

const seed = Buffer.from(seedHex, 'hex');
const blobHex = encryptBlob(seed); // reads TEE_KEY_SECRET from the environment
if (!Buffer.from(decryptBlob(blobHex)).equals(seed)) fail('self-check failed: the blob does not decrypt to the seed');

setMasterSeed(new Uint8Array(seed));
const receivers = [kvContract, FASTFS_RECEIVER, 'nova-sdk.near'];
const keys = [];
for (const r of receivers) keys.push([r, await signerPublicKeyFor(r)]);

fs.writeFileSync(OUT, JSON.stringify({ key: 'master-root', encrypted_blob: [...Buffer.from(blobHex, 'hex')] }) + '\n',
  { flag: 'wx' });

console.log('seed procedure — nothing secret below');
console.log(`  TEE_KEY_SECRET fingerprint : ${fingerprint(secret)}`);
console.log(`  MASTER_SEED fingerprint    : ${fingerprint(seedHex)}`);
console.log(`  master-root store args     : ${OUT} (ciphertext, ${blobHex.length / 2} bytes)`);
console.log('  signer public keys (add to nova-sdk.near as function-call keys):');
for (const [r, k] of keys) console.log(`    ${r.padEnd(16)} ${k}`);

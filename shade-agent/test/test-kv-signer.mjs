// shade-agent/test/test-kv-signer.mjs
//
// §5.12 R3 — lib/kv.ts signs with one scoped key PER RECEIVER, derived from the
// master seed (deriveKey "nova-signer:<receiver>"), never with the retired
// 'kv-owner-signer-v1' key.
// OFFLINE: a fake NEAR RPC on localhost records every request. Proves:
//   S1 one distinct key per receiver (nova-kv.near, fastfs.near, nova-sdk.near),
//      deterministic, different from the master seed itself
//   S2 signerPublicKeyFor() is the ed25519 public key of signerSeedFor()
//   S3 a KV store call: the nonce lookup asks for nova-sdk.near + the nova-kv.near
//      key, and the broadcast signature verifies under that key only
//   S4 a fastfs.near call uses a different key than nova-kv.near
//   S5 before the master seed is loaded: refuses, and makes no RPC call
//   S6 missing access key → error names the receiver
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 signerSeedFor returns getMasterSeedSync() for every receiver       → S1, S3, S4
//   M2 the salt omits the receiver ("nova-signer:")                       → S1, S3, S4
//   M3 signAndBroadcastFunctionCall signs with signerSeedFor('nova-kv.near')
//      whatever the receiver                                              → S4
//
// Build first:  npm run build
// Run:          node ./test/test-kv-signer.mjs

import http from 'node:http';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

// ── fake RPC (must exist before kv.js reads NEAR_RPC_URL at import) ──
const requests = [];
let accessKeyExists = true;
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body);
    requests.push(msg);
    res.setHeader('content-type', 'application/json');
    if (msg.method === 'query' && msg.params?.request_type === 'view_access_key') {
      if (!accessKeyExists) return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { nonce: 41, block_hash: bs58.encode(crypto.randomBytes(32)) } }));
    }
    if (msg.method === 'broadcast_tx_commit') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { status: { SuccessValue: '' }, transaction: { hash: 'FAKE' } } }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unexpected' } }));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.NEAR_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.KV_CONTRACT_OWNER_ID = 'nova-sdk.near';

const { setMasterSeed, getMasterSeedSync } = await import('../dist/lib/crypto.js');
const { signerSeedFor, signerPublicKeyFor, signAndBroadcastFunctionCall } = await import('../dist/lib/kv.js');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = async (fn, needle) => {
  try { await fn(); return false; } catch (e) { return String(e?.message).includes(needle); }
};
const hex = (u8) => Buffer.from(u8).toString('hex');
const SEED = new Uint8Array(crypto.randomBytes(32)); // throwaway, never a real seed

const RECEIVERS = ['nova-kv.near', 'fastfs.near', 'nova-sdk.near'];
const args = Buffer.from(JSON.stringify({ key: 'k', encrypted_blob: [1, 2, 3] }));

// Split a signed tx (txBytes || 0x00 || sig64) and verify it under `pubB58`.
const verifySigned = async (b64, pubB58) => {
  const raw = Buffer.from(b64, 'base64');
  const txBytes = raw.subarray(0, raw.length - 65);
  const sig = raw.subarray(raw.length - 64);
  const digest = crypto.createHash('sha256').update(txBytes).digest();
  return ed25519.verifyAsync(sig, digest, bs58.decode(pubB58.replace('ed25519:', '')));
};

console.log('kv signer (master seed, per receiver)');

await check('S5 before the master seed is loaded: refuses and makes no RPC call', async () => {
  const n = requests.length;
  const refused = await refuses(
    () => signAndBroadcastFunctionCall('nova-kv.near', 'store', args, 30_000_000_000_000n, 0n),
    'Master seed not initialized');
  return refused && requests.length === n;
});

setMasterSeed(SEED);

await check('S1 one distinct key per receiver, deterministic, not the master seed itself', async () => {
  const seeds = RECEIVERS.map((r) => hex(signerSeedFor(r)));
  const again = RECEIVERS.map((r) => hex(signerSeedFor(r)));
  return new Set(seeds).size === 3 && seeds.every((s, i) => s === again[i])
    && !seeds.includes(hex(getMasterSeedSync()));
});

await check('S2 signerPublicKeyFor() = ed25519 public key of signerSeedFor()', async () => {
  const pub = await ed25519.getPublicKeyAsync(signerSeedFor('nova-kv.near'));
  return (await signerPublicKeyFor('nova-kv.near')) === `ed25519:${bs58.encode(pub)}`;
});

await check('S3 KV store: nonce lookup for nova-sdk.near + the nova-kv.near key; signature verifies under it only', async () => {
  const n = requests.length;
  await signAndBroadcastFunctionCall('nova-kv.near', 'store', args, 30_000_000_000_000n, 0n);
  const mine = requests.slice(n);
  const lookup = mine.find((m) => m.params?.request_type === 'view_access_key');
  const bcast = mine.find((m) => m.method === 'broadcast_tx_commit');
  const kvPub = await signerPublicKeyFor('nova-kv.near');
  const fastfsPub = await signerPublicKeyFor('fastfs.near');
  return lookup.params.account_id === 'nova-sdk.near' && lookup.params.public_key === kvPub
    && await verifySigned(bcast.params[0], kvPub)
    && !(await verifySigned(bcast.params[0], fastfsPub));
});

await check('S4 a fastfs.near call uses a different key than nova-kv.near', async () => {
  const n = requests.length;
  await signAndBroadcastFunctionCall('fastfs.near', '__fastdata_fastfs', Buffer.from([0]), 30_000_000_000_000n, 0n,
    { tolerateFailure: true });
  const lookup = requests.slice(n).find((m) => m.params?.request_type === 'view_access_key');
  return lookup.params.public_key === (await signerPublicKeyFor('fastfs.near'))
    && lookup.params.public_key !== (await signerPublicKeyFor('nova-kv.near'));
});

await check('S6 missing access key → error names the receiver', async () => {
  accessKeyExists = false;
  try {
    return await refuses(
      () => signAndBroadcastFunctionCall('nova-kv.near', 'store', args, 30_000_000_000_000n, 0n),
      'function-call key for receiver nova-kv.near');
  } finally { accessKeyExists = true; }
});

rpc.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

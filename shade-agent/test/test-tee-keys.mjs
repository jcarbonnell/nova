// shade-agent/test/test-tee-keys.mjs
//
// §5.12 item 1 — lib/tee-keys.ts. Proves, OFFLINE (no TEE, no network):
//   T1  three paths → three distinct 32-byte keys, each from ITS path
//   T2  same source, same keys (deterministic per path)
//   T3  production + DSTACK_SIMULATOR_ENDPOINT set → refused
//   T4  production + dstack socket missing → refused
//   T5  production + socket present → a source is returned (no fallback taken)
//   T6  outside production: no simulator opt-in → refused (no fallback key)
//   T7  a key that is not 32 bytes → refused
//   T8  the same key for two paths → refused
//   T9  getTeeKeys() throws before load; one process-wide instance after
//   T10 dstackKeySource speaks GetKey over a unix socket: request shape,
//       HTTP error, malformed body, good key
//   T11 dstackKeySource ignores DSTACK_SIMULATOR_ENDPOINT (always its own endpoint)
// Every refusal is asserted by its message.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 delete the `if (simulator)` block in production         → T3
//   M2 delete the socketExists check                            → T4, T5
//   M3 delete the 32-byte check in getKey32                     → T7
//   M4 delete the distinct-keys check in deriveTeeKeys          → T8
//   M5 derive masterSeed from TEE_KEY_PATHS.kvEncryption        → T1, T2, T9
//   M6 outside production return dstackKeySource(DSTACK_SOCKET) → T6
//
// Build first:  npm run build
// Run:          node ./test/test-tee-keys.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  TEE_KEY_PATHS, DSTACK_SOCKET, TeeKeysError,
  resolveKeySource, deriveTeeKeys, dstackKeySource,
  loadTeeKeys, getTeeKeys, _resetTeeKeysForTests,
} from '../dist/lib/tee-keys.js';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = async (fn, needle) => {
  try { await fn(); return false; }
  catch (e) { return e instanceof TeeKeysError && e.message.includes(needle); }
};
const hex = (u8) => Buffer.from(u8).toString('hex');

// A fake dstack: each path maps to its own deterministic 32-byte key.
const keyFor = (p) => new Uint8Array(crypto.createHash('sha256').update(`fake-tee:${p}`).digest());
const fakeSource = (over = {}) => ({
  calls: [],
  async getKey(p) { this.calls.push(p); return { key: over[p] ?? keyFor(p) }; },
});

console.log('tee-keys');

await check('T1 three paths → three distinct 32-byte keys, each from its own path', async () => {
  const k = await deriveTeeKeys(fakeSource());
  return k.kvEncryptionKey.length === 32 && k.masterSeed.length === 32 && k.kvSignerSeed.length === 32
    && hex(k.kvEncryptionKey) === hex(keyFor(TEE_KEY_PATHS.kvEncryption))
    && hex(k.masterSeed) === hex(keyFor(TEE_KEY_PATHS.masterSeed))
    && hex(k.kvSignerSeed) === hex(keyFor(TEE_KEY_PATHS.kvSigner))
    && new Set([hex(k.kvEncryptionKey), hex(k.masterSeed), hex(k.kvSignerSeed)]).size === 3;
});

await check('T2 deterministic: same source, same keys', async () => {
  const a = await deriveTeeKeys(fakeSource());
  const b = await deriveTeeKeys(fakeSource());
  return hex(a.kvEncryptionKey) === hex(b.kvEncryptionKey)
    && hex(a.masterSeed) === hex(b.masterSeed) && hex(a.kvSignerSeed) === hex(b.kvSignerSeed);
});

await check('T3 production + DSTACK_SIMULATOR_ENDPOINT → refused', () =>
  refuses(() => resolveKeySource(
    { NODE_ENV: 'production', DSTACK_SIMULATOR_ENDPOINT: 'http://127.0.0.1:8090' }, () => true),
    'DSTACK_SIMULATOR_ENDPOINT is set in production'));

await check('T4 production + socket missing → refused', () =>
  refuses(() => resolveKeySource({ NODE_ENV: 'production' }, () => false),
    `${DSTACK_SOCKET} not found; refusing to start without the TEE`));

await check('T5 production + socket present → a key source (checked path is the dstack socket)', async () => {
  const asked = [];
  const src = resolveKeySource({ NODE_ENV: 'production' }, (p) => { asked.push(p); return true; });
  return typeof src.getKey === 'function' && asked.length === 1 && asked[0] === DSTACK_SOCKET;
});

await check('T6 outside production without the simulator opt-in → refused (no fallback)', async () =>
  await refuses(() => resolveKeySource({ NODE_ENV: 'development' }, () => true), 'There is no fallback key')
  && await refuses(() => resolveKeySource({ NOVA_TEE_SIMULATOR: 'true' }, () => true), 'There is no fallback key')
  && await refuses(() => resolveKeySource({ DSTACK_SIMULATOR_ENDPOINT: 'http://127.0.0.1:8090' }, () => true),
    'There is no fallback key'));

await check('T7 a 31-byte key → refused', () =>
  refuses(() => deriveTeeKeys(fakeSource({ [TEE_KEY_PATHS.kvEncryption]: new Uint8Array(31) })),
    `dstack returned a 31-byte key for ${TEE_KEY_PATHS.kvEncryption}; expected 32`));

await check('T8 the same key for every path → refused', () =>
  refuses(() => deriveTeeKeys({ async getKey() { return { key: new Uint8Array(32).fill(7) }; } }),
    'dstack returned the same key for two different paths'));

await check('T9 getTeeKeys() throws before load; one instance after', async () => {
  _resetTeeKeysForTests();
  const before = await refuses(() => getTeeKeys(), 'TEE keys not loaded');
  const first = await loadTeeKeys(fakeSource());
  const second = await loadTeeKeys(fakeSource({ [TEE_KEY_PATHS.masterSeed]: new Uint8Array(32).fill(1) }));
  const ok = before && first === second && getTeeKeys() === first;
  _resetTeeKeysForTests();
  return ok;
});

// ── T10/T11: the real client against a fake guest agent on a unix socket ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tee-keys-'));
const sock = path.join(dir, 'dstack.sock');
const seen = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') });
    if (mode === 'http500') { res.statusCode = 500; return res.end('boom'); }
    if (mode === 'malformed') { res.setHeader('content-type', 'application/json'); return res.end('{"nokey":1}'); }
    const p = JSON.parse(body).path;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ key: hex(keyFor(p)), signature_chain: [] }));
  });
});
await new Promise((r) => server.listen(sock, r));

await check('T10 GetKey over the socket: request shape, HTTP error, malformed body, good key', async () => {
  const src = dstackKeySource(sock);
  mode = 'ok';
  const good = await src.getKey(TEE_KEY_PATHS.kvSigner);
  const req = seen.at(-1);
  const shapeOk = req.method === 'POST' && req.url === '/GetKey'
    && req.body.path === TEE_KEY_PATHS.kvSigner && req.body.algorithm === 'secp256k1';
  mode = 'http500';
  const e500 = await refuses(() => src.getKey('x'), 'dstack GetKey x failed: HTTP 500');
  mode = 'malformed';
  const eBad = await refuses(() => src.getKey('y'), 'dstack GetKey y: malformed response');
  mode = 'ok';
  return shapeOk && hex(good.key) === hex(keyFor(TEE_KEY_PATHS.kvSigner)) && e500 && eBad;
});

await check('T11 the client ignores DSTACK_SIMULATOR_ENDPOINT', async () => {
  const saved = process.env.DSTACK_SIMULATOR_ENDPOINT;
  process.env.DSTACK_SIMULATOR_ENDPOINT = 'http://127.0.0.1:1'; // nothing listens there
  try {
    const n = seen.length;
    const k = await dstackKeySource(sock).getKey(TEE_KEY_PATHS.masterSeed);
    return seen.length === n + 1 && hex(k.key) === hex(keyFor(TEE_KEY_PATHS.masterSeed));
  } finally {
    if (saved === undefined) delete process.env.DSTACK_SIMULATOR_ENDPOINT;
    else process.env.DSTACK_SIMULATOR_ENDPOINT = saved;
  }
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

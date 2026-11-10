// shade-agent/test/test-seed.mjs
//
// §5.12 R2 — lib/seed.ts is LOAD-ONLY: it reads `master-root` (GCM, under
// TEE_KEY_SECRET) from KV and never writes it. OFFLINE: a fake NEAR RPC on
// localhost serves the KV `get` view and records every request. Proves:
//   SD1 a GCM master-root loads: the seed equals the one encrypted; later calls
//       make no further RPC request
//   SD2 an RPC failure THROWS (never read as "no seed"); nothing is set
//   SD3 master-root missing → refused by name; no write is attempted
//   SD4 a legacy CBC master-root is refused
//   SD5 a master-root that is not 32 bytes is refused
//   SD6 five concurrent first calls share ONE KV read
//   SD7 MASTER_SEED_INIT_ALLOWED=true with master-root missing → still refused,
//       still no write (the init branch is gone)
// "No write" = the fake RPC never sees view_access_key or a broadcast.
// Test secrets and seeds are random, never real.
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 read with getBlobFromKV (non-strict) instead of getBlobFromKVStrict → SD2
//   M2 drop the 32-byte check                                               → SD5
//   M3 drop the in-flight sharing (call loadMasterSeed() directly)          → SD6
//   M4 put back an init branch: when MASTER_SEED_INIT_ALLOWED=true and the
//      blob is missing, generate a seed and storeBlobToKV it               → SD7
//
// Build first:  npm run build
// Run:          node ./test/test-seed.mjs     (about 4 s: SD2 waits out the RPC retries)

import http from 'node:http';
import crypto from 'node:crypto';

// ── fake RPC (must exist before kv.js reads NEAR_RPC_URL at import) ──
const requests = [];
let mode = 'ok';            // 'ok' | 'missing' | 'error'
let storedBytes = null;     // what the KV `get` view returns
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body);
    requests.push(msg.method === 'query' ? `query:${msg.params?.request_type}` : msg.method);
    res.setHeader('content-type', 'application/json');
    if (msg.method === 'query' && msg.params?.request_type === 'call_function' && msg.params.method_name === 'get') {
      if (mode === 'error') {
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'fake outage' } }));
      }
      const value = mode === 'missing' ? null : storedBytes;
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { result: [...Buffer.from(JSON.stringify(value))] } }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unexpected' } }));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.NEAR_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.TEE_KEY_SECRET = crypto.randomBytes(32).toString('hex');
delete process.env.MASTER_SEED_INIT_ALLOWED;

const { initializeMasterSeed } = await import('../dist/lib/seed.js');
const { encryptBlob, hasMasterSeed, getMasterSeedSync, setMasterSeed } = await import('../dist/lib/crypto.js');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refuses = async (fn, needle) => {
  try { await fn(); return false; } catch (e) { return String(e?.message).includes(needle); }
};
const wrote = () => requests.some((r) => r === 'query:view_access_key' || r.startsWith('broadcast'));
const asStored = (hex) => [...Buffer.from(hex, 'hex')];
// crypto.ts has no "unset": a fresh process per state would be heavier, so the
// harness resets the in-memory seed through setMasterSeed(null) on its own module.
const unset = () => setMasterSeed(null);

console.log('seed (load-only master-root)');

await check('SD3 master-root missing → refused by name; no write attempted', async () => {
  unset(); mode = 'missing'; requests.length = 0;
  const refused = await refuses(() => initializeMasterSeed(), 'master-root not found in');
  return refused && !hasMasterSeed() && !wrote();
});

await check('SD7 MASTER_SEED_INIT_ALLOWED=true, master-root missing → still refused, no write', async () => {
  unset(); mode = 'missing'; requests.length = 0;
  process.env.MASTER_SEED_INIT_ALLOWED = 'true';
  try {
    const refused = await refuses(() => initializeMasterSeed(), 'master-root not found in');
    return refused && !hasMasterSeed() && !wrote();
  } finally { delete process.env.MASTER_SEED_INIT_ALLOWED; }
});

await check('SD2 an RPC failure throws (never "no seed"); nothing is set', async () => {
  unset(); mode = 'error'; requests.length = 0;
  let message = '';
  try { await initializeMasterSeed(); } catch (e) { message = String(e?.message); }
  return message.includes('fake outage') && !message.includes('not found') && !hasMasterSeed() && !wrote();
});

await check('SD4 a legacy CBC master-root is refused', async () => {
  unset(); mode = 'ok';
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(process.env.TEE_KEY_SECRET, 'hex'), iv);
  storedBytes = [...Buffer.concat([iv, c.update(crypto.randomBytes(32)), c.final()])];
  return (await refuses(() => initializeMasterSeed(), 'missing NOVG header')) && !hasMasterSeed();
});

await check('SD5 a master-root that is not 32 bytes is refused', async () => {
  unset(); mode = 'ok';
  storedBytes = asStored(encryptBlob(crypto.randomBytes(31)));
  return (await refuses(() => initializeMasterSeed(), 'master-root holds 31 bytes; expected 32')) && !hasMasterSeed();
});

await check('SD6 five concurrent first calls share one KV read', async () => {
  unset(); mode = 'ok'; requests.length = 0;
  const seed = crypto.randomBytes(32);
  storedBytes = asStored(encryptBlob(seed));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => initializeMasterSeed()));
  const reads = requests.filter((r) => r === 'query:call_function').length;
  return reads === 1 && results.every((s) => Buffer.from(s).equals(seed));
});

await check('SD1 a GCM master-root loads the exact seed; later calls make no RPC request', async () => {
  unset(); mode = 'ok'; requests.length = 0;
  const seed = crypto.randomBytes(32);
  storedBytes = asStored(encryptBlob(seed));
  const first = await initializeMasterSeed();
  const n = requests.length;
  const second = await initializeMasterSeed();
  return Buffer.from(first).equals(seed) && Buffer.from(getMasterSeedSync()).equals(seed)
    && second === first && requests.length === n && !wrote();
});

rpc.close();
delete process.env.TEE_KEY_SECRET;
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

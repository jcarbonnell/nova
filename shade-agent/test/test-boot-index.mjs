// shade-agent/test/test-boot-index.mjs
//
// §5.12 R4 — src/index.ts boot sequence on the portable design. Starts
// dist/index.js as a child process against a FAKE NEAR RPC on localhost, which
// also serves the KV `get` view (`master-root`, GCM under a throwaway
// TEE_KEY_SECRET). The child gets ONLY the variables below and runs in an empty
// temp directory, so dotenv finds no .env: no real secret is ever loaded.
// Proves:
//   I1 TEE_KEY_SECRET missing → exits non-zero (named), never listens
//   I2 production + MASTER_SEED_INIT_ALLOWED → exits ("Retired variable(s) still set")
//   I3 the seed loads from KV and the three signer public keys are logged, equal
//      to signerPublicKeyFor() for nova-kv.near, fastfs.near, nova-sdk.near under
//      the same seed
//   I4 GET / answers 200 with master_seed "loaded"
//   I5 ShadeClient talks to NEAR_RPC_URL (the fake RPC sees `status`), not FastNear
//   I6 no derivationPath: two boots → two different agent accounts
//   I7 funding sends 0.4 NEAR (§5.12 D4, lib/registration.ts) from the sponsor; without a
//      sponsor, no funding at all
//   I8 master-root missing → Shade still listens, reports master_seed "not loaded"
//      and status "degraded", and logs master_seed_load_failed (bind-first, 7.5)
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 load the seed BEFORE serve() and let a failure throw              → I8
//   M2 put back `derivationPath: sponsor!.privateKey` in ShadeClient.create → I6
//   M3 drop the `rpc:` line from ShadeClient.create                      → I5
//   M4 AGENT_FUND_NEAR = 1 (lib/registration.ts)                          → I7
//
// Build first:  npm run build
// Run:          node ./test/test-boot-index.mjs

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};

// ── the throwaway root secret and seed, and master-root as the KV stores it ──
const SECRET = crypto.randomBytes(32).toString('hex');
const SEED = crypto.randomBytes(32);
let masterRoot = null; // byte array served by the KV `get` view; null = missing

// ── fake NEAR RPC: status, protocol config, view_account, KV get; refuses the rest ──
const rpcSeen = [];
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body);
    rpcSeen.push(msg.method + (msg.params?.request_type ? `:${msg.params.request_type}` : ''));
    res.setHeader('content-type', 'application/json');
    if (msg.method === 'status') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { chain_id: 'mainnet' } }));
    }
    if (msg.method === 'EXPERIMENTAL_protocol_config') { // read by getBalance()
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { runtime_config: { storage_amount_per_byte: '10000000000000000000' } } }));
    }
    if (msg.method === 'query' && msg.params?.request_type === 'call_function'
        && msg.params.method_name === 'get') {
      const { key } = JSON.parse(Buffer.from(msg.params.args_base64, 'base64').toString());
      const value = key === 'master-root' ? masterRoot : null;
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { result: [...Buffer.from(JSON.stringify(value))] } }));
    }
    if (msg.method === 'query' && msg.params?.request_type === 'view_account') {
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        amount: '0', locked: '0', storage_usage: 0, code_hash: '11111111111111111111111111111111',
        block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
      error: { code: -32000, message: 'fake rpc: unsupported', data: 'unsupported' } }));
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const rpcPort = await listen(rpc);
const freePort = () => new Promise((r) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

// A throwaway ed25519 key in NEAR's format, generated here: never a real one.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (buf) => { let n = BigInt('0x' + buf.toString('hex')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const throwawayKey = `ed25519:${b58(crypto.randomBytes(64))}`;

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-index-'));
const baseEnv = (port) => ({
  PATH: process.env.PATH,
  PORT: String(port),
  AGENT_CONTRACT_ID: 'shade-agent.nova-sdk.near',
  KV_CONTRACT_ID: 'nova-kv.near',
  AUTH0_DOMAIN: 'boot-test.invalid',
  NEAR_RPC_URL: `http://127.0.0.1:${rpcPort}`,
  NODE_ENV: 'development',
  TEE_KEY_SECRET: SECRET,
});
const sponsorEnv = { SPONSOR_ACCOUNT_ID: 'nova-sponsor.near', SPONSOR_PRIVATE_KEY: throwawayKey };

// Start the child; resolve when `until(output)` holds, it exits, or the timeout hits.
function boot(env, until, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { cwd: emptyDir, env });
    let out = '';
    const done = (exitCode) => { clearTimeout(t); clearInterval(poll); child.kill('SIGKILL');
      resolve({ out, exitCode }); };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => done(code));
    const poll = setInterval(async () => { if (until && await until(out)) done(null); }, 200);
    const t = setTimeout(() => done(null), timeoutMs);
  });
}
const getRoot = (port) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/`, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
                          catch { resolve({ status: res.statusCode, json: null }); } });
  }).on('error', () => resolve(null));
});

// master-root and the expected signer keys, through the real lib code.
process.env.NEAR_RPC_URL = `http://127.0.0.1:${rpcPort}`;
process.env.TEE_KEY_SECRET = SECRET;
const { encryptBlob, setMasterSeed } = await import('../dist/lib/crypto.js');
const { signerPublicKeyFor } = await import('../dist/lib/kv.js');
masterRoot = [...Buffer.from(encryptBlob(SEED), 'hex')];
setMasterSeed(new Uint8Array(SEED));
const expected = {};
for (const r of ['nova-kv.near', 'fastfs.near', 'nova-sdk.near']) expected[r] = await signerPublicKeyFor(r);

console.log('boot (index.ts)');

await check('I1 TEE_KEY_SECRET missing → exits non-zero (named), never listens', async () => {
  const port = await freePort();
  let everListened = false;
  const env = { ...baseEnv(port) }; delete env.TEE_KEY_SECRET;
  const r = await boot(env, async () => {
    if (await getRoot(port)) everListened = true;
    return false;
  }, 8_000);
  return r.exitCode !== null && r.exitCode !== 0
    && r.out.includes('Missing required environment variables: TEE_KEY_SECRET') && !everListened;
});

await check('I2 production + MASTER_SEED_INIT_ALLOWED → exits (retired variable)', async () => {
  const r = await boot({ ...baseEnv(await freePort()), NODE_ENV: 'production', MASTER_SEED_INIT_ALLOWED: 'true' },
    null, 8_000);
  return r.exitCode !== null && r.exitCode !== 0
    && r.out.includes('Retired variable(s) still set: MASTER_SEED_INIT_ALLOWED');
});

const agentOf = async (port) => (await getRoot(port))?.json?.agent_account;

let first;
await check('I3 + I4 seed loaded from KV, signer keys logged = signerPublicKeyFor(); GET / 200, seed "loaded"', async () => {
  const port = await freePort();
  let root = null;
  first = await boot({ ...baseEnv(port), ...sponsorEnv }, async (out) => {
    root = await getRoot(port);
    return out.includes('Funding agent') && out.includes('nova-sdk.near: ed25519:')
      && !!root?.json?.agent_account && root?.json?.master_seed === 'loaded';
  });
  first.agent = root?.json?.agent_account;
  const lines = Object.entries(expected).map(([r, k]) => `   ${r}: ${k}`);
  return lines.every((l) => first.out.includes(l)) && root?.status === 200
    && root.json?.service === 'nova-shade-agent-2.0' && root.json?.master_seed === 'loaded';
});

await check('I5 ShadeClient uses NEAR_RPC_URL (fake RPC saw status + view_account)', async () =>
  rpcSeen.includes('status') && rpcSeen.includes('query:view_account'));

await check('I6 no derivationPath: a second boot gets a different agent account', async () => {
  const port = await freePort();
  let agent = null;
  await boot({ ...baseEnv(port), ...sponsorEnv }, async () => !!(agent = await agentOf(port)));
  return /^[0-9a-f]{64}$/.test(first.agent ?? '') && /^[0-9a-f]{64}$/.test(agent ?? '') && agent !== first.agent;
});

await check('I7 funding: 0.4 NEAR from the sponsor (D4); no sponsor → no funding', async () => {
  const funded = /"event":"agent_funding"[^\n]*"amount":0\.4[,}]/.test(first.out);
  const port = await freePort();
  let agent = null;
  const r = await boot({ ...baseEnv(port) },
    async (out) => !!(agent = await agentOf(port)) && out.includes('Registering agent'));
  return funded && !!agent && !r.out.includes('"event":"agent_funding"') && r.out.includes('Sponsor Account: none');
});

await check('I8 master-root missing → still listens: seed "not loaded", degraded, failure logged', async () => {
  const saved = masterRoot;
  masterRoot = null;
  try {
    const port = await freePort();
    let root = null;
    const r = await boot({ ...baseEnv(port) }, async (out) => {
      root = await getRoot(port);
      return !!root && out.includes('master_seed_load_failed');
    }, 10_000);
    return root?.status === 200 && root.json?.master_seed === 'not loaded'
      && root.json?.status === 'degraded' && r.out.includes('master-root not found in')
      && !r.out.includes('Signer keys');
  } finally { masterRoot = saved; }
});

rpc.close();
fs.rmSync(emptyDir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

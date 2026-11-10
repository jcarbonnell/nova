// shade-agent/test/test-boot-index.mjs
//
// §5.12 item 1c-iv-b — src/index.ts boot sequence. Starts dist/index.js as a child
// process against a FAKE dstack (GetKey over HTTP) and a FAKE NEAR RPC, both on
// localhost. The child gets ONLY the variables below and runs in an empty temp
// directory, so dotenv finds no .env: no real secret is ever loaded.
// Proves:
//   I1 no TEE key source → exits non-zero ("There is no fallback key"), never listens
//   I2 production + TEE_KEY_SECRET → exits ("Retired root secret(s) still set")
//   I3 logs the three signer public keys, equal to signerPublicKeyFor() for
//      nova-kv.near, fastfs.near and nova-sdk.near under the same TEE keys
//   I4 GET / answers 200 after the keys load
//   I5 ShadeClient talks to NEAR_RPC_URL (the fake RPC sees `status`), not FastNear
//   I6 no derivationPath: two boots → two different agent accounts
//   I7 funding sends 0.1 NEAR from the sponsor; without a sponsor, no funding at all
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 move `await loadTeeKeys()` below serve()                         → I1
//   M2 put back `derivationPath: sponsor!.privateKey` in ShadeClient.create → I6
//   M3 drop the `rpc:` line from ShadeClient.create                    → I5
//   M4 AGENT_FUND_NEAR = 1                                              → I7
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

// ── fake dstack: GetKey over HTTP, one deterministic key per path ──
const keyFor = (p) => crypto.createHash('sha256').update(`boot-test:${p}`).digest();
const dstack = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { path: p } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ key: keyFor(p).toString('hex'), signature_chain: [] }));
  });
});

// ── fake NEAR RPC: answers status, protocol config and view_account; refuses the rest ──
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
const dstackPort = await listen(dstack);
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
});
const simulator = { NODE_ENV: 'development', NOVA_TEE_SIMULATOR: 'true',
  DSTACK_SIMULATOR_ENDPOINT: `http://127.0.0.1:${dstackPort}` };
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

// Expected signer keys: same TEE keys, through the real lib code.
process.env.NEAR_RPC_URL = `http://127.0.0.1:${rpcPort}`;
const { loadTeeKeys, _resetTeeKeysForTests } = await import('../dist/lib/tee-keys.js');
const { signerPublicKeyFor } = await import('../dist/lib/kv.js');
await loadTeeKeys({ async getKey(p) { return { key: new Uint8Array(keyFor(p)) }; } });
const expected = {};
for (const r of ['nova-kv.near', 'fastfs.near', 'nova-sdk.near']) expected[r] = await signerPublicKeyFor(r);
_resetTeeKeysForTests();

console.log('boot (index.ts)');

await check('I1 no TEE key source → exits non-zero, never listens', async () => {
  const port = await freePort();
  let everListened = false;
  const r = await boot({ ...baseEnv(port), NODE_ENV: 'development' }, async () => {
    if (await getRoot(port)) everListened = true;
    return false;
  }, 8_000);
  return r.exitCode !== null && r.exitCode !== 0 && r.out.includes('There is no fallback key')
    && !everListened && !r.out.includes('Signer keys');
});

await check('I2 production + TEE_KEY_SECRET → exits (retired root secret)', async () => {
  const r = await boot({ ...baseEnv(await freePort()), NODE_ENV: 'production', TEE_KEY_SECRET: 'ab'.repeat(32) },
    null, 8_000);
  return r.exitCode !== null && r.exitCode !== 0 && r.out.includes('Retired root secret(s) still set: TEE_KEY_SECRET');
});

const agentOf = async (port) => (await getRoot(port))?.json?.agent_account;

let first;
await check('I3 + I4 signer keys logged and equal to signerPublicKeyFor(); GET / answers 200', async () => {
  const port = await freePort();
  let root = null;
  first = await boot({ ...baseEnv(port), ...simulator, ...sponsorEnv }, async (out) => {
    root = await getRoot(port);
    return out.includes('Funding agent') && !!root?.json?.agent_account;
  });
  first.agent = root?.json?.agent_account;
  const lines = Object.entries(expected).map(([r, k]) => `   ${r}: ${k}`);
  return lines.every((l) => first.out.includes(l)) && root?.status === 200
    && root.json?.service === 'nova-shade-agent-2.0';
});

await check('I5 ShadeClient uses NEAR_RPC_URL (fake RPC saw status + view_account)', async () =>
  rpcSeen.includes('status') && rpcSeen.includes('query:view_account'));

await check('I6 no derivationPath: a second boot gets a different agent account', async () => {
  const port = await freePort();
  let agent = null;
  await boot({ ...baseEnv(port), ...simulator, ...sponsorEnv }, async () => !!(agent = await agentOf(port)));
  return /^[0-9a-f]{64}$/.test(first.agent ?? '') && /^[0-9a-f]{64}$/.test(agent ?? '') && agent !== first.agent;
});

await check('I7 funding: 0.1 NEAR from the sponsor; no sponsor → no funding', async () => {
  const funded = first.out.includes('Funding agent with 0.1 NEAR from nova-sponsor.near');
  const port = await freePort();
  let agent = null;
  const r = await boot({ ...baseEnv(port), ...simulator },
    async (out) => !!(agent = await agentOf(port)) && out.includes('Registering agent'));
  return funded && !!agent && !r.out.includes('Funding agent') && r.out.includes('Sponsor Account: none');
});

dstack.close(); rpc.close();
fs.rmSync(emptyDir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

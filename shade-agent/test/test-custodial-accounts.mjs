// shade-agent/test/test-custodial-accounts.mjs
//
// lib/services/custodial-accounts.ts — operator-created custodial testnet accounts.
// OFFLINE: a fake NEAR RPC plays nova-kv-2.near (the current KV; every `store` tx is
// decoded and its ed25519 signature verified before it is applied) and testnet
// (view_account, view_access_key_list). Secrets and the seed are random.
//
//   C1 off the allowlist: refused by name before any KV or chain read; the allowlist
//      is exactly the six ironclaw-swarm testnet names
//   C2 prepare, account absent: returns the PUBLIC key derived independently here
//      (HKDF-SHA256(seed, "custodial-account:{id}", "nova-v1")); state absent;
//      nothing written; no private field in the response
//   C3 prepare: account holding exactly that key → ready; with another key → refused
//      (CUSTODIAL_ACCOUNT_TAKEN)
//   C4 finalize before the account exists: refused (CUSTODIAL_ACCOUNT_NOT_READY),
//      nothing written
//   C5 finalize: account:{id} holds a private key that derives the account's only
//      on-chain key, network testnet, no wallet; an API key that verifies for this
//      account, returned in the body; state created; no private key in the response
//   C6 finalize again: done, no API key in the body, nothing written
//   C7 reissue_api_key: a new key (next version) that verifies; the previous one no
//      longer does
//   C8 an extra key on the account (anyone's): finalize refused, nothing written
//   C9 a stored record with another key: refused (CUSTODIAL_RECORD_MISMATCH), no
//      API key issued
//   C10 an RPC failure is never read as "absent": prepare and finalize refuse
//      (CUSTODIAL_CHAIN_UNAVAILABLE), nothing written
//   C11 no log line carries the private key or the API key
//   C12 the routes are internal; no output field is private, secret or seed; only
//      finalize's output has api_key
//   C13 MCP's signing path (account-only retrieve) returns the stored key
//   C14 two accounts never share a key; prepare and finalize agree on it
//
// Mutations: test/mutate-custodial-accounts.mjs.
// Build first:  npm run build
// Run:          node ./test/test-custodial-accounts.mjs

import http from 'node:http';
import crypto, { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

const CUR = 'nova-kv-2.near', ED = 'ed25519:';
const A1 = 'ironclaw-swarm-agent1.nova-sdk-7.testnet', OWNER = 'ironclaw-swarm.nova-sdk-7.testnet';

// ── fake chain + KV ──
const kv = new Map();
const chain = new Map();          // testnet account → Map<pk, {full}>
let chainDown = false;
const requests = [], stores = [];

function readStoreTx(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(); const s = buf.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const bytes = (n) => { const b = buf.subarray(o, o + n); o += n; return b; };
  const signer = str(); bytes(1); const signerPub = bytes(32); o += 8;
  const receiver = str(); bytes(32); const n = u32(); const actions = [];
  for (let i = 0; i < n; i++) {
    if (bytes(1)[0] !== 2) throw new Error('not a function call');
    const method = str(); const args = JSON.parse(bytes(u32()).toString()); bytes(8); bytes(16);
    actions.push({ method, args });
  }
  const txBytes = buf.subarray(0, o); bytes(1);
  return { signer, signerPub, receiver, actions, txBytes, sig: bytes(64) };
}

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const msg = JSON.parse(body); const p = msg.params || {};
    res.setHeader('content-type', 'application/json');
    const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const err = (name) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { name: 'HANDLER_ERROR', cause: { name }, message: 'Server error' } }));
    if (msg.method === 'query' && p.request_type === 'call_function' && p.method_name === 'get' && p.account_id === CUR) {
      const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
      requests.push('kv-get');
      return ok({ result: [...Buffer.from(JSON.stringify(kv.get(args.key) ?? null))] });
    }
    if (msg.method === 'query' && p.request_type === 'view_account') {
      requests.push(`account:${p.account_id}`);
      if (chainDown) return err('TIMEOUT_ERROR');
      return chain.has(p.account_id) ? ok({ amount: '1000000000000000000000000', locked: '0' }) : err('UNKNOWN_ACCOUNT');
    }
    if (msg.method === 'query' && p.request_type === 'view_access_key_list') {
      requests.push(`keys:${p.account_id}`);
      if (chainDown) return err('TIMEOUT_ERROR');
      const keys = chain.get(p.account_id);
      return ok({ keys: keys ? [...keys].map(([pk, k]) => ({ public_key: pk, access_key: { nonce: 1, permission: k.full ? 'FullAccess' : { FunctionCall: {} } } })) : [] });
    }
    if (msg.method === 'query' && p.request_type === 'view_access_key') {
      return ok({ nonce: 7, block_hash: bs58.encode(Buffer.alloc(32, 1)) }); // Shade's KV signer
    }
    if (msg.method === 'broadcast_tx_commit') {
      const t = readStoreTx(Buffer.from(msg.params[0], 'base64'));
      const good = await ed25519.verifyAsync(t.sig, crypto.createHash('sha256').update(t.txBytes).digest(), t.signerPub);
      if (!good || t.receiver !== CUR) return err('INVALID_TRANSACTION');
      for (const a of t.actions) if (a.method === 'store') { kv.set(a.args.key, a.args.encrypted_blob); stores.push(a.args.key); }
      requests.push('kv-store');
      return ok({ transaction: { hash: `kvtx${stores.length}` }, status: { SuccessValue: '' } });
    }
    err('UNEXPECTED');
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${rpc.address().port}`;
process.env.NEAR_RPC_URL = url;
process.env.NEAR_TESTNET_RPC_URL = url;
process.env.KV_CONTRACT_ID = CUR;
process.env.TEE_KEY_SECRET = crypto.randomBytes(32).toString('hex');
const out = (s) => process.stdout.write(s + '\n');
const logs = [];
console.log = () => {};
console.info = console.warn = console.error = (...a) => logs.push(a.join(' '));

const { setMasterSeed, decryptBlob, sha256Hex } = await import('../dist/lib/crypto.js');
const S = await import('../dist/lib/services/custodial-accounts.js');
const U = await import('../dist/lib/services/user-keys.js');
const SEED = new Uint8Array(crypto.randomBytes(32));
setMasterSeed(SEED);

// Independent derivation (the test's own HKDF, not the module's).
async function expectedKeypair(account) {
  const seed = new Uint8Array(hkdfSync('sha256', SEED, Buffer.from(`custodial-account:${account}`), Buffer.from('nova-v1'), 32));
  const pub = await ed25519.getPublicKeyAsync(seed);
  return { seed, pub: `${ED}${bs58.encode(pub)}` };
}
const randomPub = async () => `${ED}${bs58.encode(await ed25519.getPublicKeyAsync(crypto.randomBytes(32)))}`;
const accRecord = (a) => { const b = kv.get(sha256Hex(`account:${a}`)); return b ? JSON.parse(Buffer.from(decryptBlob(b)).toString()) : null; };
const verifies = async (key, account) => {
  const r = await U.verifyApiKey({ api_key: key, account_id: account });
  return r.kind === 'checked' && r.valid === true;
};

function world({ accounts = {} } = {}) {
  kv.clear(); chain.clear(); requests.length = 0; stores.length = 0; logs.length = 0; chainDown = false;
  for (const [a, keys] of Object.entries(accounts)) chain.set(a, new Map(keys.map((k) => [k, { full: true }])));
}
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const is = (e, code) => !!e && e.code === code;

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, out(`  ✓ ${name}`)) : (fail++, out(`  ✗ ${name}`)); }
  catch (e) { fail++; out(`  ✗ ${name} — threw: ${e?.message || e}`); }
};

out('custodial accounts (operator route)');

await check('C1 off the allowlist: refused before any KV or chain read; the allowlist is exactly the six names', async () => {
  world();
  const e1 = await refusal(() => S.prepareCustodialAccount({ account_id: 'efizzy.nova-sdk-7.testnet' }));
  const e2 = await refusal(() => S.finalizeCustodialAccount({ account_id: 'gmail-14.nova-sdk.near' }));
  const want = ['ironclaw-swarm', ...[1, 2, 3, 4, 5].map((n) => `ironclaw-swarm-agent${n}`)].map((n) => `${n}.nova-sdk-7.testnet`).sort();
  return is(e1, 'CUSTODIAL_NOT_ALLOWED') && is(e2, 'CUSTODIAL_NOT_ALLOWED') && requests.length === 0
    && JSON.stringify([...S.CUSTODIAL_ALLOWLIST].sort()) === JSON.stringify(want);
});

await check('C2 prepare, absent: the independently derived public key; state absent; nothing written; no private field', async () => {
  world();
  const exp = await expectedKeypair(A1);
  const r = await S.prepareCustodialAccount({ account_id: A1 });
  return r.state === 'absent' && r.public_key === exp.pub && stores.length === 0
    && JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['account_id', 'public_key', 'state']);
});

await check('C3 prepare: exactly that key → ready; another key on the account → refused', async () => {
  const exp = await expectedKeypair(A1);
  world({ accounts: { [A1]: [exp.pub] } });
  const r = await S.prepareCustodialAccount({ account_id: A1 });
  world({ accounts: { [A1]: [await randomPub()] } });
  const e = await refusal(() => S.prepareCustodialAccount({ account_id: A1 }));
  return r.state === 'ready' && is(e, 'CUSTODIAL_ACCOUNT_TAKEN') && stores.length === 0;
});

await check('C4 finalize before the account exists: refused, nothing written', async () => {
  world();
  const e = await refusal(() => S.finalizeCustodialAccount({ account_id: A1 }));
  return is(e, 'CUSTODIAL_ACCOUNT_NOT_READY') && stores.length === 0;
});

let firstKey;
await check('C5 finalize: the record holds the on-chain key (testnet, no wallet); a verifying API key; state created', async () => {
  const exp = await expectedKeypair(A1);
  world({ accounts: { [A1]: [exp.pub] } });
  const r = await S.finalizeCustodialAccount({ account_id: A1 });
  const rec = accRecord(A1);
  const seed = bs58.decode(rec.private_key.slice(ED.length)).slice(0, 32);
  const derives = `${ED}${bs58.encode(await ed25519.getPublicKeyAsync(seed))}` === exp.pub;
  firstKey = r.api_key;
  return r.state === 'created' && r.public_key === exp.pub && derives && rec.public_key === exp.pub
    && rec.network === 'testnet' && rec.wallet_id === null && rec.account_id === A1
    && /^nova_sk_/.test(r.api_key) && r.api_key_version === 1 && await verifies(r.api_key, A1)
    && !JSON.stringify(r).includes('private') && !JSON.stringify(r).includes(rec.private_key.slice(ED.length, ED.length + 20));
});

await check('C6 finalize again: done, no API key in the body, nothing written', async () => {
  const n = stores.length;
  const r = await S.finalizeCustodialAccount({ account_id: A1 });
  return r.state === 'done' && !('api_key' in r) && stores.length === n && await verifies(firstKey, A1);
});

await check('C7 reissue_api_key: a new key (next version) verifies; the previous one no longer does', async () => {
  const r = await S.finalizeCustodialAccount({ account_id: A1, reissue_api_key: true });
  return r.state === 'reissued' && r.api_key_version === 2 && r.api_key !== firstKey
    && await verifies(r.api_key, A1) && !(await verifies(firstKey, A1));
});

await check('C8 an extra key on the account: finalize refused, nothing written', async () => {
  const exp = await expectedKeypair(A1);
  world({ accounts: { [A1]: [exp.pub, await randomPub()] } });
  const e = await refusal(() => S.finalizeCustodialAccount({ account_id: A1 }));
  return is(e, 'CUSTODIAL_ACCOUNT_TAKEN') && stores.length === 0;
});

await check('C9 a stored record with another key: refused, no API key issued', async () => {
  const exp = await expectedKeypair(A1);
  world({ accounts: { [A1]: [exp.pub] } });
  const { encryptBlob } = await import('../dist/lib/crypto.js');
  kv.set(sha256Hex(`account:${A1}`), [...Buffer.from(encryptBlob(Buffer.from(JSON.stringify({ account_id: A1, public_key: await randomPub() }))), 'hex')]);
  const e1 = await refusal(() => S.finalizeCustodialAccount({ account_id: A1 }));
  const e2 = await refusal(() => S.prepareCustodialAccount({ account_id: A1 }));
  return is(e1, 'CUSTODIAL_RECORD_MISMATCH') && is(e2, 'CUSTODIAL_RECORD_MISMATCH') && stores.length === 0
    && !kv.has(sha256Hex(`api-hash:${A1}`));
});

await check('C10 an RPC failure is never "absent": prepare and finalize refuse, nothing written', async () => {
  world();
  chainDown = true;
  const e1 = await refusal(() => S.prepareCustodialAccount({ account_id: A1 }));
  const e2 = await refusal(() => S.finalizeCustodialAccount({ account_id: A1 }));
  return is(e1, 'CUSTODIAL_CHAIN_UNAVAILABLE') && is(e2, 'CUSTODIAL_CHAIN_UNAVAILABLE') && stores.length === 0;
});

await check('C11 no log line carries the private key or the API key', async () => {
  const exp = await expectedKeypair(OWNER);
  world({ accounts: { [OWNER]: [exp.pub] } });
  const r = await S.finalizeCustodialAccount({ account_id: OWNER });
  const r2 = await S.finalizeCustodialAccount({ account_id: OWNER, reissue_api_key: true });
  const secretB58 = accRecord(OWNER).private_key.slice(ED.length);
  const all = logs.join('\n');
  return logs.length > 0 && !all.includes(r.api_key) && !all.includes(r2.api_key)
    && !all.includes(secretB58) && !all.includes(secretB58.slice(0, 16)) && !all.includes(r.api_key.slice(8, 24));
});

await check('C12 the routes are internal; no private/secret/seed output field; only finalize has api_key', async () => {
  const router = readFileSync(new URL('../dist/rpc/router.js', import.meta.url), 'utf8');
  const { CustodialPrepareOutput, CustodialFinalizeOutput } = await import('../dist/lib/schemas.js');
  const p = Object.keys(CustodialPrepareOutput.shape), f = Object.keys(CustodialFinalizeOutput.shape);
  const bad = (fs) => fs.some((x) => /private|secret|seed/.test(x));
  return /path: '\/accounts\/custodial\/prepare',\s*tags: INTERNAL/.test(router)
    && /path: '\/accounts\/custodial\/finalize',\s*tags: INTERNAL/.test(router)
    && /accounts: \{ custodialPrepare: accountsCustodialPrepare, custodialFinalize: accountsCustodialFinalize \}/.test(router)
    && !bad(p) && !bad(f) && !p.includes('api_key') && f.includes('api_key');
});

await check('C13 MCP\'s signing path (account-only retrieve) returns the stored key', async () => {
  const exp = await expectedKeypair(A1);
  world({ accounts: { [A1]: [exp.pub] } });
  await S.finalizeCustodialAccount({ account_id: A1 });
  const k = await U.retrieveUserKey({ account_id: A1 });
  return k.account_id === A1 && k.public_key === exp.pub && k.network === 'testnet' && k.private_key === accRecord(A1).private_key;
});

await check('C14 two accounts never share a key; prepare and finalize agree', async () => {
  world();
  const a = await S.prepareCustodialAccount({ account_id: A1 });
  const b = await S.prepareCustodialAccount({ account_id: OWNER });
  world({ accounts: { [OWNER]: [b.public_key] } });
  const f = await S.finalizeCustodialAccount({ account_id: OWNER });
  return a.public_key !== b.public_key && f.public_key === b.public_key;
});

rpc.close();
out(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

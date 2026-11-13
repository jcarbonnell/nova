// shade-agent/test/test-rekey.mjs
//
// §5.12 L3 — lib/services/rekey.ts. OFFLINE: a fake NEAR RPC plays nova-kv-2.near
// (current KV), nova-kv.near (pre-switch KV, records written with the OLD code's
// GCM under the old secret) and the CHAIN: per-account access keys, nonces, and
// broadcast_tx_commit. Every broadcast is DECODED (borsh), its ed25519 signature
// VERIFIED against the signing key, and applied atomically: KV `store` calls go to
// the KV maps, AddKey/DeleteKey to the account's keys. Secrets are random.
//
//   R1 plan (no confirm): old key and keys to delete reported; nothing written or sent
//   R2 confirm: the pending key is stored in the current KV BEFORE the re-key tx
//   R3 ONE tx: signer = receiver = the account, signed by the old key, actions
//      exactly [AddKey(new, FullAccess), DeleteKey(old)]
//   R4 an attacker's extra key is deleted in that same tx
//   R5 after: the new key is the account's only key; account:{id} and user:{sub} in
//      the current KV hold it (it derives its public key); the pending record keeps
//      no private key; the response carries no private key
//   R6 a second run: done, nothing sent or written
//   R7 the tx fails after the pending key was stored: refused; the re-run reuses
//      the SAME pending key (never a second one) and completes
//   R8 the tx landed but the records were not written: the re-run sends nothing
//      and writes the records
//   R9 an account off the allowlist: refused before any KV or chain read
//   R10 a sub naming another account, a wallet-linked record, a key that does not
//      derive its public key, a testnet record: each refused by name, nothing sent
//   R11 the old key no longer on chain: refused, no pending key stored, nothing sent
//   R12 the chain does not show the new key alone after the tx: refused, records
//      not written
//   R13 the route is internal, and its output schema has no private-key field
//   R15 a POST-switch user:{sub} (current KV) is never taken as the pre-switch record
//   R14 near-js's own decoder (an independent oracle) reads the re-key tx the same way,
//      and our AddKey/DeleteKey bytes equal near-js's actionCreators
//
// Mutations: test/mutate-rekey.mjs.
// Build first:  npm run build
// Run:          node ./test/test-rekey.mjs

import http from 'node:http';
import crypto, { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

const CUR = 'nova-kv-2.near', OLD = 'nova-kv.near', ACC = 'gmail-14.nova-sdk.near', SUB = 'google-oauth2|1234567890';
const ED = 'ed25519:';

// ── fake chain + KV ──
const kv = { [CUR]: new Map(), [OLD]: new Map() };
const chain = new Map();          // account → { keys: Map<pk, {full, nonce}> }
let failAccountTx = false, noApply = false;
const requests = [], txs = [];

function readBorsh(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(); const s = buf.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const bytes = (n) => { const b = buf.subarray(o, o + n); o += n; return b; };
  const pk = () => { if (bytes(1)[0] !== 0) throw new Error('not ed25519'); return `${ED}${bs58.encode(bytes(32))}`; };
  const signer = str(); const signerPk = pk(); const nonce = buf.readBigUInt64LE(o); o += 8;
  const receiver = str(); bytes(32); const n = u32(); const actions = [];
  for (let i = 0; i < n; i++) {
    const tag = bytes(1)[0];
    if (tag === 2) { const method = str(); const args = bytes(u32()); bytes(8); bytes(16); actions.push({ type: 'FunctionCall', method, args: JSON.parse(args.toString()) }); }
    else if (tag === 5) { const k = pk(); bytes(8); const perm = bytes(1)[0]; actions.push({ type: 'AddKey', pk: k, full: perm === 1 }); }
    else if (tag === 6) { actions.push({ type: 'DeleteKey', pk: pk() }); }
    else throw new Error(`unexpected action ${tag}`);
  }
  const txLen = o;
  if (bytes(1)[0] !== 0) throw new Error('bad signature type');
  return { signer, signerPk, nonce, receiver, actions, txBytes: buf.subarray(0, txLen), sig: bytes(64) };
}

const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const msg = JSON.parse(body); const p = msg.params || {};
    res.setHeader('content-type', 'application/json');
    const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const err = (m) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: m } }));
    if (msg.method === 'query' && p.request_type === 'call_function' && p.method_name === 'get' && kv[p.account_id]) {
      const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
      requests.push(`get:${p.account_id}`);
      return ok({ result: [...Buffer.from(JSON.stringify(kv[p.account_id].get(args.key) ?? null))] });
    }
    if (msg.method === 'query' && p.request_type === 'view_access_key_list') {
      requests.push(`keys:${p.account_id}`);
      const a = chain.get(p.account_id);
      return ok({ keys: a ? [...a.keys].map(([pk, k]) => ({ public_key: pk, access_key: { nonce: k.nonce, permission: k.full ? 'FullAccess' : { FunctionCall: {} } } })) : [] });
    }
    if (msg.method === 'query' && p.request_type === 'view_access_key') {
      requests.push(`nonce:${p.account_id}`);
      const k = chain.get(p.account_id)?.keys.get(p.public_key);
      if (!k && p.account_id !== 'nova-sdk.near') return err('access key does not exist');
      return ok({ nonce: k?.nonce ?? 7, block_hash: bs58.encode(Buffer.alloc(32, 1)) });
    }
    if (msg.method === 'broadcast_tx_commit') {
      const t = readBorsh(Buffer.from(msg.params[0], 'base64'));
      const good = await ed25519.verifyAsync(t.sig, crypto.createHash('sha256').update(t.txBytes).digest(), bs58.decode(t.signerPk.slice(3 + 5)));
      txs.push({ ...t, sigValid: good, raw: msg.params[0] });
      if (!good) return err('invalid signature');
      if (t.actions.every((a) => a.type === 'FunctionCall')) {
        for (const a of t.actions) if (a.method === 'store') kv[t.receiver].set(a.args.key, a.args.encrypted_blob);
        requests.push(`store:${t.receiver}`);
        return ok({ transaction: { hash: `kvtx${txs.length}` }, status: { SuccessValue: '' } });
      }
      requests.push(`accounttx:${t.receiver}`);
      if (failAccountTx) return err('fake broadcast outage');
      const a = chain.get(t.signer);
      if (!a || !a.keys.get(t.signerPk)?.full) return ok({ transaction: { hash: 'x' }, status: { Failure: { ActionError: 'not a full access key' } } });
      if (!noApply) {
        const next = new Map(a.keys);
        for (const x of t.actions) {
          if (x.type === 'AddKey') next.set(x.pk, { full: x.full, nonce: 0 });
          if (x.type === 'DeleteKey') { if (!next.has(x.pk)) return ok({ transaction: { hash: 'x' }, status: { Failure: { ActionError: 'DeleteKeyDoesNotExist' } } }); next.delete(x.pk); }
        }
        a.keys = next;
      }
      return ok({ transaction: { hash: `rekeytx${txs.length}` }, status: { SuccessValue: '' } });
    }
    err('unexpected');
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
process.env.NEAR_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
process.env.KV_CONTRACT_ID = CUR;
process.env.TEE_KEY_SECRET = crypto.randomBytes(32).toString('hex');
const OLD_SECRET = crypto.randomBytes(32).toString('hex');
process.env.LEGACY_TEE_KEY_SECRET = OLD_SECRET;
const out = (s) => process.stdout.write(s + '\n');
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};

const legacy = await import('../dist/lib/legacy.js');
const { setMasterSeed, decryptBlob, sha256Hex } = await import('../dist/lib/crypto.js');
const R = await import('../dist/lib/services/rekey.js');
setMasterSeed(new Uint8Array(crypto.randomBytes(32)));
legacy._setLegacyPinsForTest({
  masterRootSha256: '0'.repeat(64), signerPublicKey: 'ed25519:none',
  secretFingerprint: crypto.createHash('sha256').update(OLD_SECRET).digest('hex').slice(0, 12),
});

// Old code (3ca43d8): GCM "NOVG" blobs under the old secret.
const oldEncrypt = (data) => {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(OLD_SECRET, 'hex'), iv);
  const ct = Buffer.concat([c.update(Buffer.from(data)), c.final()]);
  return [...Buffer.concat([Buffer.from('NOVG'), iv, c.getAuthTag(), ct])];
};
const newKeypair = async () => {
  const seed = crypto.randomBytes(32); const pub = await ed25519.getPublicKeyAsync(seed);
  return { seed, pub: `${ED}${bs58.encode(pub)}`, secret: `${ED}${bs58.encode(Buffer.concat([seed, pub]))}` };
};
const userKey = (sub) => sha256Hex(`user:${sub}`), accKey = (a) => sha256Hex(`account:${a}`), pendKey = (a) => sha256Hex(`rekey-pending:${a}`);
const readCur = (k) => { const b = kv[CUR].get(k); return b ? JSON.parse(Buffer.from(decryptBlob(b)).toString()) : null; };

let OLDKEY;
async function world({ record = {}, extraKeys = [], oldOnChain = true } = {}) {
  kv[CUR].clear(); kv[OLD].clear(); chain.clear(); txs.length = 0; requests.length = 0;
  failAccountTx = false; noApply = false;
  OLDKEY = await newKeypair();
  const rec = { account_id: ACC, private_key: OLDKEY.secret, public_key: OLDKEY.pub, network: 'mainnet', wallet_id: null, created_at: '2026-05-04T00:00:00Z', ...record };
  kv[OLD].set(userKey(SUB), oldEncrypt(JSON.stringify(rec)));
  const keys = new Map();
  if (oldOnChain) keys.set(OLDKEY.pub, { full: true, nonce: 41 });
  for (const k of extraKeys) keys.set(k, { full: true, nonce: 3 });
  chain.set(ACC, { keys });
}
const rekey = (over = {}) => R.rekeyAccount({ account_id: ACC, sub: SUB, ...over });
const accountTxs = () => txs.filter((t) => t.receiver === ACC);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const is = (e, code, needle) => !!e && e.code === code && (!needle || String(e.message).includes(needle));
const chainKeys = () => [...chain.get(ACC).keys.keys()];

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, out(`  ✓ ${name}`)) : (fail++, out(`  ✗ ${name}`)); }
  catch (e) { fail++; out(`  ✗ ${name} — threw: ${e?.message || e}`); }
};

out('re-key (§5.12 L3)');

await check('R1 plan: old key and keys to delete reported; nothing written or sent', async () => {
  await world();
  const r = await rekey();
  return r.state === 'plan' && r.old_public_key === OLDKEY.pub && JSON.stringify(r.deleted_keys) === JSON.stringify([OLDKEY.pub])
    && txs.length === 0 && kv[CUR].size === 0;
});

await check('R2 confirm: the pending key is stored in the current KV BEFORE the re-key tx', async () => {
  await world();
  await rekey({ confirm: true });
  const iPend = txs.findIndex((t) => t.actions[0]?.args?.key === pendKey(ACC));
  const iAcc = txs.findIndex((t) => t.receiver === ACC);
  return iPend >= 0 && iAcc > iPend && txs[iPend].receiver === CUR;
});

await check('R3 one tx, signer = receiver = the account, signed by the old key: [AddKey(new, full), DeleteKey(old)]', async () => {
  await world();
  const r = await rekey({ confirm: true });
  const t = accountTxs();
  return t.length === 1 && t[0].signer === ACC && t[0].signerPk === OLDKEY.pub && t[0].sigValid
    && JSON.stringify(t[0].actions) === JSON.stringify([{ type: 'AddKey', pk: r.new_public_key, full: true }, { type: 'DeleteKey', pk: OLDKEY.pub }]);
});

await check('R4 an attacker\'s extra key is deleted in that same tx', async () => {
  const attacker = (await newKeypair()).pub;
  await world({ extraKeys: [attacker] });
  const r = await rekey({ confirm: true });
  const t = accountTxs();
  const dels = t[0].actions.filter((a) => a.type === 'DeleteKey').map((a) => a.pk).sort();
  return t.length === 1 && JSON.stringify(dels) === JSON.stringify([OLDKEY.pub, attacker].sort())
    && JSON.stringify(chainKeys()) === JSON.stringify([r.new_public_key]);
});

await check('R5 after: new key alone on chain; both records hold it; pending keeps no secret; response has none', async () => {
  await world();
  const r = await rekey({ confirm: true });
  const acc = readCur(accKey(ACC)), usr = readCur(userKey(SUB)), pend = readCur(pendKey(ACC));
  const seed = bs58.decode(acc.private_key.slice(3 + 5)).slice(0, 32);
  const derives = `${ED}${bs58.encode(await ed25519.getPublicKeyAsync(seed))}` === r.new_public_key;
  return r.state === 'rekeyed' && JSON.stringify(chainKeys()) === JSON.stringify([r.new_public_key])
    && acc.public_key === r.new_public_key && usr.private_key === acc.private_key && derives && !!acc.rekeyed_at
    && acc.created_at === '2026-05-04T00:00:00Z' && pend.done === true && !('new_private_key' in pend)
    && !JSON.stringify(r).includes('private') && !JSON.stringify(r).includes(acc.private_key.slice(3 + 5, 20));
});

await check('R6 a second run: done; nothing sent or written', async () => {
  await world();
  const first = await rekey({ confirm: true });
  const n = txs.length;
  const r = await rekey({ confirm: true });
  return r.state === 'done' && r.new_public_key === first.new_public_key && txs.length === n;
});

await check('R7 the tx fails after the pending key was stored; the re-run reuses the SAME key and completes', async () => {
  await world();
  failAccountTx = true;
  const e = await refusal(() => rekey({ confirm: true }));
  const pend1 = readCur(pendKey(ACC));
  failAccountTx = false;
  const r = await rekey({ confirm: true });
  const pendStores = txs.filter((t) => t.actions[0]?.args?.key === pendKey(ACC)).length;
  return !!e && JSON.stringify(chainKeys()) === JSON.stringify([pend1.new_public_key])
    && r.new_public_key === pend1.new_public_key && r.state === 'rekeyed' && pendStores === 2; // stored once + done marker
});

await check('R8 the tx landed but the records were not written: the re-run sends nothing, writes the records', async () => {
  await world();
  await rekey({ confirm: true });
  const newPub = chainKeys()[0];
  kv[CUR].delete(accKey(ACC)); kv[CUR].delete(userKey(SUB));
  // restore the pending record as it was before the records were written
  const pend = readCur(pendKey(ACC));
  const secretTx = txs.find((t) => t.actions[0]?.args?.key === pendKey(ACC));
  kv[CUR].set(pendKey(ACC), secretTx.actions[0].args.encrypted_blob);
  const before = accountTxs().length;
  const r = await rekey({ confirm: true });
  return pend.done && r.state === 'rekeyed' && accountTxs().length === before && r.tx_hash === null
    && readCur(accKey(ACC)).public_key === newPub && readCur(userKey(SUB)).public_key === newPub;
});

await check('R9 off the allowlist: refused before any KV or chain read', async () => {
  await world();
  const e = await refusal(() => R.rekeyAccount({ account_id: 'efizzy.nova-sdk.near', sub: SUB, confirm: true }));
  return is(e, 'REKEY_NOT_ALLOWED') && requests.length === 0 && R.REKEY_ALLOWLIST.size === 2
    && R.REKEY_ALLOWLIST.has('gmail-14.nova-sdk.near') && R.REKEY_ALLOWLIST.has('hello-partage.nova-sdk.near');
});

await check('R10 another account\'s sub, a wallet record, a non-deriving key, testnet: refused by name, nothing sent', async () => {
  const cases = [
    [{ account_id: 'hello-partage.nova-sdk.near' }, 'REKEY_SUB_MISMATCH'],
    [{ wallet_id: 'gmail-14.near' }, 'REKEY_NOT_CUSTODIAL'],
    [{ public_key: (await newKeypair()).pub }, 'REKEY_KEY_MISMATCH'],
    [{ network: 'testnet' }, 'REKEY_NETWORK'],
  ];
  for (const [record, code] of cases) {
    await world({ record });
    const e = await refusal(() => rekey({ confirm: true }));
    if (!is(e, code) || txs.length) return false;
  }
  await world();
  return is(await refusal(() => R.rekeyAccount({ account_id: ACC, sub: 'auth0|nobody', confirm: true })), 'REKEY_RECORD_NOT_FOUND');
});

await check('R11 the old key no longer on chain: refused; no pending key; nothing sent', async () => {
  await world({ oldOnChain: false, extraKeys: [(await newKeypair()).pub] });
  const e = await refusal(() => rekey({ confirm: true }));
  return is(e, 'REKEY_OLD_KEY_ABSENT') && txs.length === 0 && !kv[CUR].has(pendKey(ACC));
});

await check('R12 the chain does not show the new key alone: refused, records not written', async () => {
  await world();
  noApply = true;
  const e = await refusal(() => rekey({ confirm: true }));
  return is(e, 'REKEY_UNVERIFIED') && !kv[CUR].has(accKey(ACC)) && !kv[CUR].has(userKey(SUB));
});

await check('R13 the route is internal and its output has no private-key field', async () => {
  const router = readFileSync(new URL('../dist/rpc/router.js', import.meta.url), 'utf8');
  const { RekeyOutput } = await import('../dist/lib/schemas.js');
  const fields = Object.keys(RekeyOutput.shape);
  return /path: '\/migration\/rekey',\s*tags: INTERNAL/.test(router) && /migration: \{ rekey: migrationRekey \}/.test(router)
    && !fields.some((f) => /private|secret|seed/.test(f));
});

await check('R14 near-js (independent oracle) decodes the re-key tx identically; action bytes match', async () => {
  const T = await import('@near-js/transactions');
  const { PublicKey } = await import('@near-js/crypto');
  const borsh = await import('borsh');
  await world();
  const r = await rekey({ confirm: true });
  const st = T.decodeSignedTransaction(Buffer.from(accountTxs()[0].raw, 'base64'));
  const tx = st.transaction;
  const pkOf = (k) => `${ED}${bs58.encode(Buffer.from(k.ed25519Key.data))}`;
  const same = tx.signerId === ACC && tx.receiverId === ACC && pkOf(tx.publicKey) === OLDKEY.pub
    && tx.actions.length === 2 && pkOf(tx.actions[0].addKey.publicKey) === r.new_public_key
    && tx.actions[0].addKey.accessKey.permission.fullAccess !== undefined && pkOf(tx.actions[1].deleteKey.publicKey) === OLDKEY.pub;
  const pk = PublicKey.fromString(OLDKEY.pub);
  const hex = (a) => Buffer.from(borsh.serialize(T.SCHEMA.Action, a)).toString('hex');
  return same && hex(T.actionCreators.addKey(pk, T.actionCreators.fullAccessKey())) === R.encodeAddFullAccessKey(OLDKEY.pub).toString('hex')
    && hex(T.actionCreators.deleteKey(pk)) === R.encodeDeleteKey(OLDKEY.pub).toString('hex');
});

await check('R15 a post-switch user:{sub} in the current KV is never taken as the pre-switch record', async () => {
  await world();
  const { encryptBlob } = await import('../dist/lib/crypto.js');
  const k = await newKeypair();
  kv[CUR].set(userKey(SUB), [...Buffer.from(encryptBlob(Buffer.from(JSON.stringify({
    account_id: ACC, private_key: k.secret, public_key: k.pub, network: 'mainnet', wallet_id: null })))
    , 'hex')]);
  const e = await refusal(() => rekey({ confirm: true }));
  return is(e, 'REKEY_RECORD_NOT_FOUND') && txs.length === 0;
});

rpc.close();
out(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

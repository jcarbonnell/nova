// shade-agent/test/test-legacy.mjs
//
// §5.12 L1–L2 — lib/legacy.ts + the era-aware reads in key-management.ts and
// fastfs-storage.ts. OFFLINE: a fake NEAR RPC on localhost plays nova-kv-2.near
// (current KV), nova-kv.near (pre-switch KV) and nova-sdk.near (is_authorized),
// records every request, and applies every broadcast KV `store` to the current KV.
//
// Pre-switch fixtures are written with the OLD code, copied verbatim from commit
// 3ca43d8 (unchanged through shade v61, the image the old CVM ran): encryptBlob
// (GCM "NOVG" under the old secret), deriveKey (HKDF under the old seed), the
// file-key / group-version / file-meta / tombstone record shapes, and a CBC
// master-root. All secrets and seeds are random, never real.
//
//   E1 a pre-switch file key (unrotated group) is served byte-identical (era legacy)
//   E2 a pre-switch file key of a rotated group (v N) is served byte-identical
//   E3 a post-switch file key is still served from the new seed (no regression)
//   E4 the current KV wins: a post-switch tombstone shadows a pre-switch key → FILE_DELETED
//   E5 a pre-switch tombstone → FILE_DELETED
//   E6 not authorized → 403, and neither KV is read
//   E7 current KV unreachable → 503 KV_UNAVAILABLE, the pre-switch KV is never read
//   E8 pre-switch KV unreachable → 503 KV_UNAVAILABLE
//   E9 a pre-switch file-format record is read (era legacy), and retrieveFile's
//      source reads it through readRecord
//   W1 a new file key in a group whose version record is pre-switch: written to the
//      CURRENT KV with that version, wrapped under the NEW seed, never the old one
//   W2 current KV unreachable at upload → 503, nothing broadcast
//   G1 getGroupKey: a pre-switch version record → the old seed's key for that version
//   G2 getGroupKey: no version record → the new seed's base key (L3 gap, documented)
//   P1 LEGACY_TEE_KEY_SECRET unset → pre-switch records 503 by name; post-switch fine
//   P2 a secret that does not match the pinned fingerprint → refused by name
//   P3 a master-root that does not match its pinned hash → refused by name
//   P4 a seed that does not derive the pinned old signer key → refused by name
//   P5 a master-root that is not 32 bytes → refused by name
//   P6 a pre-switch record that does not decrypt under the legacy secret → refused
//   P7 five concurrent first uses read master-root ONCE
//   P8 KV_CONTRACT_ID = nova-kv.near, or unset → refused (KV_MISCONFIGURED), in fresh processes
//   P9 the production pins are the recorded values
//   K1 L4: the first verified load copies the old secret into the CURRENT KV
//      (legacy-tee-key, under the new secret); `/` status says so
//   K2 L4: with the copy stored, the env can go: pre-switch files still served, no write
//   K3 L4: an existing copy is never rewritten (env present or not)
//   K4 L4: a copy that fails the fingerprint pin is refused, with NO fallback to the env
//   K5 L4: a secret that fails a later pin (signer) is never copied
//   K6 L4: a failed copy write is not fatal (served from the env; retried next load)
//   K7 L4: initializeLegacy() at boot stores the copy with no request; with no source
//      at all it neither throws nor writes
//   K8 index.ts calls initializeLegacy() after the master seed and reports the status on `/`
//
// Mutations: test/mutate-legacy.mjs (each must turn its named checks ✗).
//
// Build first:  npm run build
// Run:          node ./test/test-legacy.mjs

import http from 'node:http';
import crypto, { hkdfSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

const CUR = 'nova-kv-2.near', OLD = 'nova-kv.near', NOVA = 'nova-sdk.near';

// ── fake RPC (before any dist import: config.ts reads the env at load) ──
const kv = { [CUR]: new Map(), [OLD]: new Map() };
const down = { [CUR]: false, [OLD]: false };
let authorized = true;
let failBroadcast = false;
const requests = [];
const rpc = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body);
    const p = msg.params || {};
    res.setHeader('content-type', 'application/json');
    const ok = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    const err = (m) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: m } }));
    if (msg.method === 'query' && p.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8'));
      requests.push(`${p.account_id}.${p.method_name}${args.key ? `(${args.key})` : ''}`);
      if (p.method_name === 'get' && kv[p.account_id]) {
        if (down[p.account_id]) return err('fake outage');
        const v = kv[p.account_id].get(args.key) ?? null;
        return ok({ result: [...Buffer.from(JSON.stringify(v))] });
      }
      if (p.account_id === NOVA && p.method_name === 'is_authorized') return ok({ result: [...Buffer.from(JSON.stringify(authorized))] });
      if (p.account_id === NOVA && p.method_name === 'group_contains_key') return ok({ result: [...Buffer.from('true')] });
      return err('unexpected view');
    }
    if (msg.method === 'query' && p.request_type === 'view_access_key') {
      requests.push('view_access_key');
      return ok({ nonce: 7, block_hash: bs58.encode(Buffer.alloc(32, 1)) });
    }
    if (msg.method === 'broadcast_tx_commit') {
      if (failBroadcast) { requests.push('broadcast:failed'); return err('fake broadcast outage'); }
      const tx = Buffer.from(msg.params[0], 'base64').toString('latin1');
      const m = tx.match(/\{"key":"([^"]*)","encrypted_blob":\[([0-9,]*)\]\}/);
      const receiver = tx.includes(CUR) ? CUR : tx.includes(OLD) ? OLD : '?';
      requests.push(`broadcast:${receiver}`);
      if (m) kv[receiver]?.set(m[1], m[2].split(',').map(Number));
      return ok({ transaction: { hash: 'faketx' }, status: { SuccessValue: '' } });
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

// Shade logs to stdout; keep the harness output readable.
const out = (s) => process.stdout.write(s + '\n');
console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};

const legacy = await import('../dist/lib/legacy.js');
const { setMasterSeed, deriveKey, gcmUnwrap, sha256Hex, encryptBlob } = await import('../dist/lib/crypto.js');
const km = await import('../dist/lib/services/key-management.js');

// ── the OLD code, verbatim from 3ca43d8 (key and seed passed in) ──
const GCM_MAGIC = Buffer.from([0x4e, 0x4f, 0x56, 0x47]);
function oldEncryptBlob(data, secretHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(secretHex, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([GCM_MAGIC, iv, tag, encrypted]).toString('hex');
}
const oldDeriveKey = (seed, salt, length = 32) =>
  new Uint8Array(hkdfSync('sha256', seed, Buffer.from(salt), Buffer.from('nova-v1'), length));
function oldGcmWrap(data, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('hex');
}
const groupSalt = (g, v) => (v ? `group:${g}:mainnet:${NOVA}:v${v}` : `group:${g}:mainnet:${NOVA}`);
const fileKeyId = (g, ref) => sha256Hex(`file-key:${g}:${ref}`);
const versionId = (g) => sha256Hex(`group-version:${g}:mainnet:${NOVA}`);
const metaId = (g, ref) => sha256Hex(`file-meta:${g}:${ref}`);
const stored = (hex) => [...Buffer.from(hex, 'hex')];
const oldCbcRaw = (data, secretHex) => {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', Buffer.from(secretHex, 'hex'), iv);
  return [...Buffer.concat([iv, c.update(Buffer.from(data)), c.final()])];
};
const nearPub = async (seed32) => `ed25519:${bs58.encode(await ed25519.getPublicKeyAsync(seed32))}`;

// ── the two worlds ──
const OLD_SEED = crypto.randomBytes(32), NEW_SEED = crypto.randomBytes(32);
setMasterSeed(new Uint8Array(NEW_SEED));
const masterRoot = oldCbcRaw(OLD_SEED, OLD_SECRET);
const PINS = {
  masterRootSha256: crypto.createHash('sha256').update(Buffer.from(masterRoot)).digest('hex'),
  secretFingerprint: crypto.createHash('sha256').update(OLD_SECRET).digest('hex').slice(0, 12),
  signerPublicKey: await nearPub(oldDeriveKey(OLD_SEED, 'kv-owner-signer-v1')),
};
const resetLegacy = (pins = PINS) => legacy._setLegacyPinsForTest(pins);
const world = () => {
  kv[CUR].clear(); kv[OLD].clear(); down[CUR] = down[OLD] = false; authorized = true;
  kv[OLD].set('master-root', masterRoot);
  process.env.LEGACY_TEE_KEY_SECRET = OLD_SECRET;
  resetLegacy(); requests.length = 0;
};
/** A pre-switch file: a random file key wrapped under the OLD group key v, stored with the old code. */
const oldFile = (g, ref, v = null) => {
  const fileKey = crypto.randomBytes(32);
  const w = oldGcmWrap(fileKey, oldDeriveKey(OLD_SEED, groupSalt(g, v)));
  kv[OLD].set(fileKeyId(g, ref), stored(oldEncryptBlob(Buffer.from(JSON.stringify({ v, w })), OLD_SECRET)));
  return fileKey;
};
const oldVersion = (g, v) => kv[OLD].set(versionId(g), stored(oldEncryptBlob(Buffer.from(JSON.stringify({
  key: oldEncryptBlob(oldDeriveKey(OLD_SEED, groupSalt(g, v)), OLD_SECRET), version: String(v) })), OLD_SECRET)));
const TOMB = Buffer.from('NOVA_FILE_TOMBSTONE_v1', 'utf8');

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, out(`  ✓ ${name}`)) : (fail++, out(`  ✗ ${name}`)); }
  catch (e) { fail++; out(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const is = (e, status, code, needle) =>
  !!e && e.statusCode === status && e.code === code && (!needle || String(e.message).includes(needle));
const b64 = (u8) => Buffer.from(u8).toString('base64');
const get = (g, ref) => km.getFileKey({ group_id: g, file_ref: ref, account_id: 'alice.near' });
const G = 'agent-owned-20261030T073943Z';

out('legacy reader (§5.12 L1–L2)');

await check('E1 a pre-switch file key (unrotated group) is served byte-identical', async () => {
  world(); const fk = oldFile(G, 'p/r1');
  const r = await get(G, 'p/r1');
  return r.file_key === b64(fk) && r.version === 'base';
});

await check('E2 a pre-switch file key of a rotated group (v N) is served byte-identical', async () => {
  world(); const fk = oldFile(G, 'p/r2', '1793000000000');
  const r = await get(G, 'p/r2');
  return r.file_key === b64(fk) && r.version === '1793000000000';
});

await check('E3 a post-switch file key is still served from the new seed', async () => {
  world();
  const gen = await km.generateFileKey({ group_id: 'new-group', file_ref: 'q/n1', account_id: 'alice.near' });
  requests.length = 0;
  const r = await get('new-group', 'q/n1');
  return r.file_key === gen.file_key && !requests.some((x) => x.startsWith(`${OLD}.get(${fileKeyId('new-group', 'q/n1')}`));
});

await check('E4 the current KV wins: a post-switch tombstone shadows a pre-switch key → FILE_DELETED', async () => {
  world(); oldFile(G, 'p/r4');
  kv[CUR].set(fileKeyId(G, 'p/r4'), stored(encryptBlob(TOMB)));
  return is(await refusal(() => get(G, 'p/r4')), 404, 'FILE_DELETED');
});

await check('E5 a pre-switch tombstone → FILE_DELETED', async () => {
  world(); kv[OLD].set(fileKeyId(G, 'p/r5'), stored(oldEncryptBlob(TOMB, OLD_SECRET)));
  return is(await refusal(() => get(G, 'p/r5')), 404, 'FILE_DELETED');
});

await check('E6 not authorized → 403, and neither KV is read', async () => {
  world(); oldFile(G, 'p/r6'); authorized = false;
  const e = await refusal(() => get(G, 'p/r6'));
  return is(e, 403, 'UNAUTHORIZED') && !requests.some((x) => x.includes('.get('));
});

await check('E7 current KV unreachable → 503 KV_UNAVAILABLE; the pre-switch KV is never read', async () => {
  world(); oldFile(G, 'p/r7'); down[CUR] = true;
  const e = await refusal(() => get(G, 'p/r7'));
  return is(e, 503, 'KV_UNAVAILABLE', CUR) && !requests.some((x) => x.startsWith(`${OLD}.get(`));
});

await check('E8 pre-switch KV unreachable → 503 KV_UNAVAILABLE', async () => {
  world(); oldFile(G, 'p/r8'); down[OLD] = true;
  return is(await refusal(() => get(G, 'p/r8')), 503, 'KV_UNAVAILABLE', OLD);
});

await check('E9 a pre-switch file-format record is read (era legacy); retrieveFile reads it through readRecord', async () => {
  world();
  kv[OLD].set(metaId(G, 'p/r9'), stored(oldEncryptBlob(Buffer.from(JSON.stringify({ format: 'v1' })), OLD_SECRET)));
  const r = await legacy.readRecord(metaId(G, 'p/r9'));
  const src = readFileSync(new URL('../dist/lib/services/fastfs-storage.js', import.meta.url), 'utf8');
  return r?.era === 'legacy' && JSON.parse(Buffer.from(r.bytes).toString()).format === 'v1'
    && /readRecord\(fileMetaIdFor\(group_id, file_ref\)\)/.test(src);
});

await check('W1 a new file key in a pre-switch-rotated group: current KV, same version, NEW seed only', async () => {
  world(); oldVersion(G, '1793000000000');
  const gen = await km.generateFileKey({ group_id: G, file_ref: 'p/w1', account_id: 'alice.near' });
  const raw = kv[CUR].get(fileKeyId(G, 'p/w1'));
  if (!raw || kv[OLD].has(fileKeyId(G, 'p/w1'))) return false;
  const { decryptBlob } = await import('../dist/lib/crypto.js');
  const { v, w } = JSON.parse(Buffer.from(decryptBlob(raw)).toString());
  const opensNew = b64(gcmUnwrap(w, deriveKey(groupSalt(G, v)))) === gen.file_key;
  let opensOld = true;
  try { gcmUnwrap(w, oldDeriveKey(OLD_SEED, groupSalt(G, v))); } catch { opensOld = false; }
  return v === '1793000000000' && opensNew && !opensOld && requests.includes(`broadcast:${CUR}`);
});

await check('W2 current KV unreachable at upload → 503, nothing broadcast', async () => {
  world(); down[CUR] = true;
  const e = await refusal(() => km.generateFileKey({ group_id: G, file_ref: 'p/w2', account_id: 'alice.near' }));
  return is(e, 503, 'KV_UNAVAILABLE') && !requests.some((x) => x.startsWith('broadcast'));
});

await check('G1 getGroupKey: a pre-switch version record → the old seed\'s key for that version', async () => {
  world(); oldVersion(G, '1793000000000');
  const r = await km.getGroupKey({ group_id: G, account_id: 'alice.near' });
  return r.key === b64(oldDeriveKey(OLD_SEED, groupSalt(G, '1793000000000')));
});

await check('G2 getGroupKey: no version record → the new seed\'s base key (L3 gap, documented)', async () => {
  world();
  const r = await km.getGroupKey({ group_id: G, account_id: 'alice.near' });
  return r.key === b64(deriveKey(groupSalt(G, null)));
});

await check('P1 LEGACY_TEE_KEY_SECRET unset → pre-switch 503 by name; post-switch still served', async () => {
  world();
  const gen = await km.generateFileKey({ group_id: 'new-group', file_ref: 'q/p1', account_id: 'alice.near' });
  oldFile(G, 'p/p1'); delete process.env.LEGACY_TEE_KEY_SECRET; resetLegacy();
  const e = await refusal(() => get(G, 'p/p1'));
  const r = await get('new-group', 'q/p1');
  return is(e, 503, 'LEGACY_UNAVAILABLE', 'LEGACY_TEE_KEY_SECRET is not set') && r.file_key === gen.file_key;
});

await check('P2 a secret that does not match the pinned fingerprint → refused by name', async () => {
  world(); oldFile(G, 'p/p2'); process.env.LEGACY_TEE_KEY_SECRET = crypto.randomBytes(32).toString('hex');
  return is(await refusal(() => get(G, 'p/p2')), 503, 'LEGACY_UNAVAILABLE', 'does not match its pinned fingerprint');
});

await check('P3 a master-root that does not match its pinned hash → refused by name', async () => {
  world(); oldFile(G, 'p/p3'); kv[OLD].set('master-root', oldCbcRaw(OLD_SEED, OLD_SECRET)); // new IV: other bytes
  return is(await refusal(() => get(G, 'p/p3')), 503, 'LEGACY_UNAVAILABLE', 'does not match its pinned hash');
});

await check('P4 a seed that does not derive the pinned old signer key → refused by name', async () => {
  world(); oldFile(G, 'p/p4');
  resetLegacy({ ...PINS, signerPublicKey: await nearPub(crypto.randomBytes(32)) });
  return is(await refusal(() => get(G, 'p/p4')), 503, 'LEGACY_UNAVAILABLE', 'does not derive the pinned old signer key');
});

await check('P5 a master-root that is not 32 bytes → refused by name', async () => {
  world(); oldFile(G, 'p/p5');
  const short = oldCbcRaw(crypto.randomBytes(16), OLD_SECRET); kv[OLD].set('master-root', short);
  resetLegacy({ ...PINS, masterRootSha256: crypto.createHash('sha256').update(Buffer.from(short)).digest('hex') });
  return is(await refusal(() => get(G, 'p/p5')), 503, 'LEGACY_UNAVAILABLE', 'holds 16 bytes; expected 32');
});

await check('P6 a pre-switch record that does not decrypt under the legacy secret → refused', async () => {
  world();
  kv[OLD].set(fileKeyId(G, 'p/p6'), stored(oldEncryptBlob(Buffer.from('{"v":null,"w":"00"}'), crypto.randomBytes(32).toString('hex'))));
  return is(await refusal(() => get(G, 'p/p6')), 503, 'LEGACY_UNAVAILABLE', 'did not decrypt under the legacy secret');
});

await check('P7 five concurrent first uses read master-root once', async () => {
  world(); const refs = [1, 2, 3, 4, 5].map((i) => `p/c${i}`); const fks = refs.map((r) => oldFile(G, r));
  requests.length = 0;
  const rs = await Promise.all(refs.map((r) => get(G, r)));
  return rs.every((r, i) => r.file_key === b64(fks[i]))
    && requests.filter((x) => x === `${OLD}.get(master-root)`).length === 1;
});

await check('P8 KV_CONTRACT_ID = nova-kv.near, or unset → refused (KV_MISCONFIGURED), in fresh processes', async () => {
  const code = `const l = await import(${JSON.stringify(new URL('../dist/lib/legacy.js', import.meta.url).href)});
    console.error = () => {}; console.log = () => {};
    try { await l.readRecord('x'); process.stdout.write('served'); }
    catch (e) { process.stdout.write(e.code + '|' + e.message); }`;
  const runWith = (kvId) => {
    const env = { ...process.env, NEAR_RPC_URL: 'http://127.0.0.1:9' };
    if (kvId === undefined) delete env.KV_CONTRACT_ID; else env.KV_CONTRACT_ID = kvId;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).stdout.trim();
  };
  return [OLD, undefined].every((kvId) => {
    const o = runWith(kvId);
    return o.startsWith('KV_MISCONFIGURED|') && o.includes('must be set, and not the pre-switch nova-kv.near');
  });
});

await check('P9 the production pins are the recorded values', async () => {
  const p = legacy.LEGACY_PINS;
  return legacy.LEGACY_KV_CONTRACT === OLD && Object.isFrozen(p)
    && p.masterRootSha256 === '3fcc45faf36fe08213cf8eca5c2b6d6cc9235cd761cc673b45184c0883cd837f'
    && p.secretFingerprint === 'a9a39248a959'
    && p.signerPublicKey === 'ed25519:GhFNnrrZ4roarJDPmP1VPR3KwcmCcBERkb5mdSt5kJ6R';
});

const COPY = 'legacy-tee-key';
const { decryptBlob: curDecrypt } = await import('../dist/lib/crypto.js');
const copyOf = () => kv[CUR].get(COPY);
const broadcasts = () => requests.filter((x) => x.startsWith('broadcast'));

await check('K1 L4: the first verified load stores the old secret in the current KV, under the new secret', async () => {
  world(); const fk = oldFile(G, 'p/k1');
  const r = await get(G, 'p/k1');
  const c = copyOf();
  const st = legacy.getLegacyStatus();
  return r.file_key === b64(fk) && !!c && Buffer.from(curDecrypt(c)).toString() === OLD_SECRET
    && !kv[OLD].has(COPY) && broadcasts().length === 1 && requests.includes(`broadcast:${CUR}`)
    && st.key_copy_stored === true && st.key_source === 'env' && st.seed_loaded === true;
});

await check('K2 L4: copy stored, env removed: pre-switch files still served, nothing written', async () => {
  world(); const fk = oldFile(G, 'p/k2');
  await get(G, 'p/k2');                                    // stores the copy
  delete process.env.LEGACY_TEE_KEY_SECRET; resetLegacy(); requests.length = 0;
  const r = await get(G, 'p/k2');
  const st = legacy.getLegacyStatus();
  return r.file_key === b64(fk) && broadcasts().length === 0 && st.key_source === 'kv' && st.key_copy_stored;
});

await check('K3 L4: an existing copy is never rewritten', async () => {
  world(); oldFile(G, 'p/k3');
  kv[CUR].set(COPY, stored(encryptBlob(Buffer.from(OLD_SECRET))));
  const before = JSON.stringify(copyOf());
  await get(G, 'p/k3');
  return broadcasts().length === 0 && JSON.stringify(copyOf()) === before && legacy.getLegacyStatus().key_source === 'kv';
});

await check('K4 L4: a copy that fails the fingerprint pin is refused, no fallback to the env', async () => {
  world(); oldFile(G, 'p/k4');
  kv[CUR].set(COPY, stored(encryptBlob(Buffer.from(crypto.randomBytes(32).toString('hex')))));
  const e = await refusal(() => get(G, 'p/k4'));
  return is(e, 503, 'LEGACY_UNAVAILABLE', 'stored legacy-tee-key does not match its pinned fingerprint')
    && process.env.LEGACY_TEE_KEY_SECRET === OLD_SECRET && broadcasts().length === 0;
});

await check('K5 L4: a secret that fails a later pin (signer) is never copied', async () => {
  world(); oldFile(G, 'p/k5');
  resetLegacy({ ...PINS, signerPublicKey: await nearPub(crypto.randomBytes(32)) });
  const e = await refusal(() => get(G, 'p/k5'));
  return is(e, 503, 'LEGACY_UNAVAILABLE', 'does not derive the pinned old signer key') && !copyOf() && broadcasts().length === 0;
});

await check('K6 L4: a failed copy write is not fatal; retried at the next load', async () => {
  world(); const fk = oldFile(G, 'p/k6');
  failBroadcast = true;
  const r1 = await get(G, 'p/k6');
  const st1 = legacy.getLegacyStatus();
  failBroadcast = false; resetLegacy();
  await get(G, 'p/k6');
  return r1.file_key === b64(fk) && st1.key_copy_stored === false && st1.key_source === 'env'
    && !!copyOf() && legacy.getLegacyStatus().key_copy_stored === true;
});

await check('K7 L4: initializeLegacy() stores the copy with no request; with no source, no throw, no write', async () => {
  world();
  await legacy.initializeLegacy();
  const stored1 = !!copyOf() && legacy.getLegacyStatus().seed_loaded;
  world(); delete process.env.LEGACY_TEE_KEY_SECRET; resetLegacy();
  await legacy.initializeLegacy();
  const st = legacy.getLegacyStatus();
  return stored1 && !copyOf() && broadcasts().length === 0 && st.seed_loaded === false && st.key_source === null;
});

await check('K8 index.ts: initializeLegacy() after the master seed; `/` reports the legacy status', async () => {
  const src = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  const iSeed = src.indexOf('await initializeMasterSeed();'), iLegacy = src.indexOf('await initializeLegacy();');
  return iSeed > 0 && iLegacy > iSeed && /legacy: getLegacyStatus\(\)/.test(src);
});

rpc.close();
out(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

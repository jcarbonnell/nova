// shade-agent/test/test-owner-signer-load.mjs
//
// S2.1 — loadCustodialSigner (lib/owner-signer.ts). Proves, against real KV:
//   1. a real custodial account loads; its public key is a LIVE access key on
//      chain and equals the stored one; sign() verifies under it.
//   2. the secret never appears on the returned object (JSON / inspect /
//      showHidden) nor in anything written to stdout during the load.
//   3. synthetic records: 64-byte and 32-byte secrets load; a key that does not
//      derive the stored public_key → OWNER_KEY_MISMATCH; wallet_id set →
//      OWNER_NOT_CUSTODIAL; absent → OWNER_KEY_NOT_FOUND; an RPC failure THROWS
//      and is NOT reported as not-found.
//
// MUTATIONS (each must make its named check fail):
//   M1 pubkey — delete the line `if (pubBs58 !== normalizePub(userData.public_key)) throw mismatch();`
//               → fails "stored public_key mismatch → OWNER_KEY_MISMATCH"
//   M2 wallet — delete the `if (userData.wallet_id) { ... }` block
//               → fails "wallet_id set → OWNER_NOT_CUSTODIAL"
//   M3 leak   — add `secretKey: userData.private_key,` to the frozen return object
//               → fails "secret never on the returned signer"
//
// Build first:  npm run build
// Run:          node --env-file=.env ./test/test-owner-signer-load.mjs
// Optional:     OWNER_ACCOUNT=<custodial account> (default gmail-14.nova-sdk.near)

import crypto from 'node:crypto';
import util from 'node:util';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

const OWNER = process.env.OWNER_ACCOUNT || 'gmail-14.nova-sdk.near';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  \u2713 ${name}`))
                     : (fail++, console.log(`  \u2717 ${name}`)); }
  catch (e) { fail++; console.log(`  \u2717 ${name} — threw: ${e?.message || e}`); }
};
async function settle(predicate, timeoutMs = 15_000, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

console.log('\nOwner-signer LOAD harness (S2.1)\n');

try {
  const { initializeMasterSeed } = await import('../dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const os = await import('../dist/lib/owner-signer.js');
const { storeBlobToKV, rpcCallWithRetry } = await import('../dist/lib/kv.js');
const { encryptBlob, sha256Hex } = await import('../dist/lib/crypto.js');
const { getRpcUrl } = await import('../dist/lib/config.js');
const userKeys = await import('../dist/lib/services/user-keys.js');
const axios = (await import('axios')).default;

const outcome = async (id) => {
  try { return { ok: await os.loadCustodialSigner(id) }; }
  catch (e) { return { code: e?.code, msg: e?.message || String(e) }; }
};

// ── 1. real custodial account ──
let signer;
await check(`real custodial account loads (${OWNER})`, async () => {
  signer = await os.loadCustodialSigner(OWNER);
  return signer.accountId === OWNER && /^ed25519:/.test(signer.publicKeyBs58)
      && signer.publicKey.length === 32 && typeof signer.network === 'string';
});

await check('its public key equals the stored one AND is a live access key on chain', async () => {
  const stored = await userKeys.retrieveUserKey({ account_id: OWNER });
  const storedPub = stored.public_key.startsWith('ed25519:') ? stored.public_key : `ed25519:${stored.public_key}`;
  if (storedPub !== signer.publicKeyBs58) return false;
  const ak = await rpcCallWithRetry(getRpcUrl(signer.network), {
    jsonrpc: '2.0', id: 'ak', method: 'query',
    params: { request_type: 'view_access_key', finality: 'final', account_id: OWNER, public_key: signer.publicKeyBs58 },
  });
  return ak && typeof ak.nonce !== 'undefined';
});

await check('sign() produces a signature that verifies under the public key', async () => {
  const msg = crypto.randomBytes(32);
  const sig = await signer.sign(msg);
  return sig.length === 64 && (await ed25519.verifyAsync(sig, msg, signer.publicKey));
});

// ── 2. no secret leak ──
await check('secret never on the returned signer, nor in stdout during a load', async () => {
  const stored = await userKeys.retrieveUserKey({ account_id: OWNER });
  const sk = stored.private_key;
  const body = sk.startsWith('ed25519:') ? sk.slice(8) : sk;
  const seedHex = Buffer.from(bs58.decode(body).slice(0, 32)).toString('hex');
  const needles = [sk, body, seedHex];

  let captured = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return origWrite(chunk, ...rest); };
  let s;
  try { s = await os.loadCustodialSigner(OWNER); }
  finally { process.stdout.write = origWrite; }

  const surfaces = [
    JSON.stringify(s),
    util.inspect(s, { showHidden: true, depth: 6, getters: true }),
    Object.keys(s).join(','),
    captured,
  ];
  return needles.every((n) => surfaces.every((txt) => !txt.includes(n)));
});

// ── 3. synthetic records ──
const tag = crypto.randomUUID().slice(0, 8);
const ids = {
  good64: `owner-signer-test-${tag}-good64`,
  good32: `owner-signer-test-${tag}-good32`,
  mismatch: `owner-signer-test-${tag}-mismatch`,
  wallet: `owner-signer-test-${tag}-wallet`,
  absent: `owner-signer-test-${tag}-absent`,
};
async function freshKey() {
  const seed = crypto.randomBytes(32);
  const pub = await ed25519.getPublicKeyAsync(seed);
  return { seed, pub, pubBs58: `ed25519:${bs58.encode(pub)}` };
}
async function putRecord(id, rec) {
  await storeBlobToKV(sha256Hex(`account:${id}`), encryptBlob(Buffer.from(JSON.stringify(rec), 'utf8')));
}

const k64 = await freshKey(), k32 = await freshKey(), kA = await freshKey(), kB = await freshKey(), kW = await freshKey();
const sk64 = (k) => `ed25519:${bs58.encode(Buffer.concat([k.seed, Buffer.from(k.pub)]))}`;

await putRecord(ids.good64, { account_id: ids.good64, private_key: sk64(k64), public_key: k64.pubBs58, network: 'testnet', wallet_id: null });
await putRecord(ids.good32, { account_id: ids.good32, private_key: bs58.encode(k32.seed), public_key: bs58.encode(k32.pub), network: 'mainnet', wallet_id: null });
// Self-consistent 64-byte secret of key A, but the RECORDED public key is B's → only the stored-pubkey check catches it.
await putRecord(ids.mismatch, { account_id: ids.mismatch, private_key: sk64(kA), public_key: kB.pubBs58, network: 'mainnet', wallet_id: null });
// Fully valid key material, but wallet-owned.
await putRecord(ids.wallet, { account_id: ids.wallet, private_key: sk64(kW), public_key: kW.pubBs58, network: 'mainnet', wallet_id: 'some-wallet' });

await check('64-byte secret (ed25519: prefix) loads with the right key + network', async () =>
  settle(async () => {
    const o = await outcome(ids.good64);
    return !!o.ok && o.ok.publicKeyBs58 === k64.pubBs58 && o.ok.network === 'testnet';
  }));

await check('32-byte bare-base58 secret loads; bare stored public_key accepted', async () =>
  settle(async () => {
    const o = await outcome(ids.good32);
    return !!o.ok && o.ok.publicKeyBs58 === k32.pubBs58;
  }));

await check('stored public_key mismatch → OWNER_KEY_MISMATCH', async () =>
  settle(async () => (await outcome(ids.mismatch)).code === 'OWNER_KEY_MISMATCH'));

await check('wallet_id set → OWNER_NOT_CUSTODIAL', async () =>
  settle(async () => (await outcome(ids.wallet)).code === 'OWNER_NOT_CUSTODIAL'));

await check('absent record → OWNER_KEY_NOT_FOUND', async () =>
  (await outcome(ids.absent)).code === 'OWNER_KEY_NOT_FOUND');

await check('RPC failure on the read THROWS and is NOT reported as not-found', async () => {
  const origPost = axios.post;
  axios.post = async (url, payload, cfg) => {
    if (payload?.method === 'query' && payload?.params?.method_name === 'get') {
      throw new Error('injected: KV read RPC failure');
    }
    return origPost.call(axios, url, payload, cfg);
  };
  let o;
  try { o = await outcome(ids.good64); }
  finally { axios.post = origPost; }
  return !o.ok && o.code !== 'OWNER_KEY_NOT_FOUND' && /injected/.test(o.msg);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
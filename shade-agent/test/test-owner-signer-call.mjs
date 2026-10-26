// shade-agent/test/test-owner-signer-call.mjs
//
// S2.3 — signAsOwner (lib/owner-signer.ts) against MAINNET.
//
// PROVES:
//   GUARDS (refuse BEFORE key load / BEFORE broadcast — every RPC call recorded):
//     1. non-allowlisted method → OWNER_METHOD_NOT_ALLOWED, ZERO RPC calls.
//     2. owner on mainnet, contract on testnet → OWNER_NETWORK_MISMATCH, no fee
//        query, no broadcast.
//     3. estimate_fee RPC failure → OWNER_FEE_UNAVAILABLE, no access-key read,
//        no broadcast.
//   REAL REVOKE (fixture group owned by gmail-14):
//     4. precondition: gmail-14's custodial key is FullAccess (can attach a fee).
//     5. setup via SDK (as gmail-14): add a throwaway member → is_authorized true.
//     6. signAsOwner revoke_group_member → deposit == estimate_fee exactly,
//        tx hash returned, member's is_authorized → false.
//     7. revoking again → OWNER_CALL_FAILED "not a member" (the sweep pre-checks
//        is_authorized, so this never surprises it).
//     8. signer-lock map empty afterwards.
//
// Negative cases target a NON-EXISTENT group: if a mutation lets one reach the
// chain, the contract panics "Group not found" — nothing changes.
//
// MUTATIONS (each must make its named check fail):
//   M1 allowlist — `if (!OWNER_METHOD_ALLOWLIST.has(method_name)) {`
//                → `if (!OWNER_METHOD_ALLOWLIST.has(method_name) && method_name === '\u0000') {`
//                → fails "non-allowlisted method refused before any RPC"
//   M2 network   — `if (signer.network !== network) {`
//                → `if (signer.network !== network && network === '\u0000') {`
//                → fails "network mismatch refused before fee/broadcast"
//   M3 fee       — in estimateFee's catch, replace the `throw new ApiError(...)`
//                  with `return 0n;`
//                → fails "fee RPC failure refuses to sign"
//
// Build first:  npm run build
// Run:          NOVA_API_KEY=<gmail-14 key> SDK_DIR=../nova-sdk-js \
//               node --env-file=.env ./test/test-owner-signer-call.mjs

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const API_KEY = process.env.NOVA_API_KEY;
const SDK_DIR = process.env.SDK_DIR || '../nova-sdk-js';

// SDK_DIR may be the nova-sdk-js repo itself (canonical) or a project with
// nova-sdk-js in node_modules. Resolve an importable specifier either way.
function sdkSpecifier() {
  const dir = path.resolve(SDK_DIR);
  const pkgPath = path.join(dir, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
  if (pkg.name === 'nova-sdk-js') {
    const file = path.resolve(dir, pkg.main || pkg.module || 'index.js');
    if (!fs.existsSync(file)) throw new Error(`nova-sdk-js entry not found: ${file} (build the SDK first)`);
    console.log(`SDK: nova-sdk-js ${pkg.version} from ${file}`);
    return pathToFileURL(file).href;
  }
  console.log(`SDK: resolving "nova-sdk-js" from ${dir}/node_modules`);
  return 'nova-sdk-js';
}
const SDK_SPEC = sdkSpecifier();
const OWNER = 'gmail-14.nova-sdk.near';
const GROUP = 'retention-exec-fixture';
const TESTNET_CONTRACT = 'nova-sdk-7.testnet';

if (!API_KEY) {
  console.error('Set NOVA_API_KEY (gmail-14 key) — needed for the SDK subprocess (add member).');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  \u2713 ${name}`))
                     : (fail++, console.log(`  \u2717 ${name}`)); }
  catch (e) { fail++; console.log(`  \u2717 ${name} — threw: ${e?.message || e}`); }
};
async function settle(predicate, timeoutMs = 20_000, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
// The SDK's NovaError carries the raw axios error (incl. the Authorization
// header) as `cause`; an uncaught throw prints it. So: catch INSIDE the
// subprocess, emit only a redacted message, and never echo raw stderr here.
const redact = (s) => String(s).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
function sdk(expr) {
  const code =
    `const m=await import(${JSON.stringify(SDK_SPEC)});const NovaSdk=m.NovaSdk||(m.default&&m.default.NovaSdk);` +
    `const sdk=new NovaSdk("${OWNER}",{apiKey:process.env.NOVA_API_KEY});` +
    `try { ${expr} } catch (e) {` +
    ` console.error("SDK_ERROR: " + String((e && e.message) || e).replace(/Bearer\\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]"));` +
    ` process.exit(1); }`;
  try {
    return execFileSync('node', ['--input-type=module', '-e', code], {
      cwd: path.resolve(SDK_DIR),
      env: { ...process.env, NOVA_API_KEY: API_KEY },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const line = String(e?.stderr || '').split('\n').find((l) => l.startsWith('SDK_ERROR:'));
    throw new Error(redact(line || 'SDK subprocess failed (no SDK_ERROR line)'));
  }
}

console.log('\nOwner-signer CALL harness (S2.3, mainnet)\n');

try {
  const { initializeMasterSeed } = await import('../dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const os = await import('../dist/lib/owner-signer.js');
const kv = await import('../dist/lib/kv.js');
const { viewOrThrow } = await import('../dist/lib/services/retention.js');
const { getRpcUrl } = await import('../dist/lib/config.js');
const axios = (await import('axios')).default;

const tag = crypto.randomUUID().slice(0, 8);
const MEMBER = `aw-buyer-${tag}.near`;
const NO_GROUP = `no-such-group-${tag}`;
const MAINNET_RPC = getRpcUrl('mainnet');

// Record every RPC call made through axios while fn runs. Optional `inject`
// may throw for selected payloads.
async function recordRpc(fn, inject) {
  const calls = [];
  const origPost = axios.post;
  axios.post = async (url, payload, cfg) => {
    calls.push({
      method: payload?.method,
      request_type: payload?.params?.request_type,
      method_name: payload?.params?.method_name,
    });
    if (inject) inject(payload);
    return origPost.call(axios, url, payload, cfg);
  };
  let result, error;
  try { result = await fn(); } catch (e) { error = e; }
  finally { axios.post = origPost; }
  return { calls, result, error };
}
const isBroadcast = (c) => c.method === 'broadcast_tx_commit';
const isKvGet = (c) => c.method_name === 'get';
const isFee = (c) => c.method_name === 'estimate_fee';
const isAccessKey = (c) => c.request_type === 'view_access_key';

const isAuthorized = async (user_id) =>
  (await viewOrThrow(MAINNET_RPC, 'nova-sdk.near', 'is_authorized', { group_id: GROUP, user_id })) === true;

// ── GUARDS ──
console.log('GUARDS:');

await check('non-allowlisted method refused before any RPC (OWNER_METHOD_NOT_ALLOWED)', async () => {
  const { calls, error } = await recordRpc(() => os.signAsOwner({
    owner_account_id: OWNER, method_name: 'add_group_member',
    args: { group_id: NO_GROUP, user_id: MEMBER },
  }));
  return error?.code === 'OWNER_METHOD_NOT_ALLOWED' && calls.length === 0;
});

await check('network mismatch refused before fee/broadcast (OWNER_NETWORK_MISMATCH)', async () => {
  const { calls, error } = await recordRpc(() => os.signAsOwner({
    owner_account_id: OWNER, method_name: 'revoke_group_member',
    args: { group_id: NO_GROUP, user_id: MEMBER }, contract_id: TESTNET_CONTRACT,
  }));
  return error?.code === 'OWNER_NETWORK_MISMATCH'
      && !calls.some(isFee) && !calls.some(isAccessKey) && !calls.some(isBroadcast);
});

await check('fee RPC failure refuses to sign (OWNER_FEE_UNAVAILABLE, no broadcast)', async () => {
  const { calls, error } = await recordRpc(
    () => os.signAsOwner({
      owner_account_id: OWNER, method_name: 'revoke_group_member',
      args: { group_id: NO_GROUP, user_id: MEMBER },
    }),
    (payload) => {
      if (payload?.params?.method_name === 'estimate_fee') throw new Error('injected: fee RPC failure');
    },
  );
  return error?.code === 'OWNER_FEE_UNAVAILABLE'
      && calls.some(isKvGet) && !calls.some(isAccessKey) && !calls.some(isBroadcast);
});

// ── REAL REVOKE ──
console.log('\nREAL REVOKE (mainnet, fixture group):');

let signerPub;
await check('precondition: gmail-14 custodial key is FullAccess', async () => {
  const s = await os.loadCustodialSigner(OWNER);
  signerPub = s.publicKeyBs58;
  const ak = await kv.rpcCallWithRetry(MAINNET_RPC, {
    jsonrpc: '2.0', id: 'ak', method: 'query',
    params: { request_type: 'view_access_key', finality: 'final', account_id: OWNER, public_key: signerPub },
  });
  console.log(`      permission: ${JSON.stringify(ak?.permission)}`);
  return ak?.permission === 'FullAccess';
});

await check(`setup: SDK adds throwaway member ${MEMBER} → is_authorized true`, async () => {
  // The fixture exists after the first-ever run. Check its owner with the FREE
  // get_group_owner view instead of calling register_group: MCP attaches the full
  // register fee (0.64 NEAR today) even when the call will panic "exists", so a
  // low-balance owner fails with NotEnoughBalance.
  const owner = sdk(`console.log(JSON.stringify(await sdk.getGroupOwner("${GROUP}")));`).split('\n').pop();
  console.log(`      fixture owner: ${owner}`);
  if (owner === 'null') {
    const reg = sdk(`console.log(await sdk.registerGroup("${GROUP}"));`);
    console.log(`      registerGroup: ${reg.split('\n').pop()}`);
  } else if (owner !== JSON.stringify(OWNER)) {
    console.log('      fixture group is owned by another account: cannot run');
    return false;
  }
  // MCP's py_near reads the nonce at 'final'. If registerGroup broadcast a tx
  // (even a panicking "exists" one), an immediate second call can reuse a stale
  // nonce → InvalidNonce. Let finality catch up before the add.
  await new Promise((r) => setTimeout(r, 5_000));
  const add = sdk(`console.log(await sdk.addGroupMember("${GROUP}", "${MEMBER}"));`);
  console.log(`      addGroupMember: ${add.split('\n').pop()}`);
  return settle(() => isAuthorized(MEMBER));
});

await check('signAsOwner revoke: exact fee, tx hash, member loses is_authorized', async () => {
  const r = await os.signAsOwner({
    owner_account_id: OWNER, method_name: 'revoke_group_member',
    args: { group_id: GROUP, user_id: MEMBER },
  });
  const fee = await viewOrThrow(MAINNET_RPC, 'nova-sdk.near', 'estimate_fee', { action: 'revoke_group_member' });
  console.log(`      tx: ${r.tx_hash}  deposit: ${r.deposit_yocto}  estimate_fee: ${fee}`);
  if (!r.tx_hash || r.signer_account_id !== OWNER || r.network !== 'mainnet') return false;
  if (BigInt(r.deposit_yocto) !== BigInt(String(fee))) return false;
  return settle(async () => !(await isAuthorized(MEMBER)));
});

await check('second revoke → OWNER_CALL_FAILED "not a member"', async () => {
  try {
    await os.signAsOwner({
      owner_account_id: OWNER, method_name: 'revoke_group_member',
      args: { group_id: GROUP, user_id: MEMBER },
    });
    return false;
  } catch (e) {
    return e?.code === 'OWNER_CALL_FAILED' && /not a member/i.test(e?.message || '');
  }
});

await check('signer-lock map empty afterwards', async () => {
  await new Promise((r) => setTimeout(r, 10));
  return kv._signerLockCount() === 0;
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
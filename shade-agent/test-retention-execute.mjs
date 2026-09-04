// shade-agent/test-retention-execute.mjs
//
// §6.1/§6.2 RETENTION EXECUTE harness (Piece 3). The IRREVERSIBLE path.
// Proves, against real KV + real FastFS + real contract, that execute:
//   1. dry-run (no confirm) reports the plan and destroys NOTHING.
//   2. confirm:true crypto-shreds the file key, null-writes FastFS, and
//      tombstones on-chain — KEY-FIRST.
//   3. the file is genuinely UNRECOVERABLE afterward: getFileKey → FILE_DELETED,
//      and the on-chain tx shows tombstoned.
//
// ⚠️ THIS HARNESS DESTROYS A REAL FILE. It creates its OWN throwaway file in a
// throwaway group so it never touches data you care about. The file is gone after
// — that's the proof. Each run makes a fresh one (can't re-run against a dead file).
//
// Needs the Shade env: real seed + TEE_KEY_SECRET + KV access + FastNear RPC, and
// the gmail-14 SDK for the owner-gated set/clear window (via subprocess, same as
// the scan harness). nova-sdk.near signs the destroys (it's the contract owner =
// the KV-owner signer), which the service does internally.
//
// Build first:  npm run build
// Run:          NOVA_API_KEY=<gmail-14 key> SDK_DIR=../nova-ai-memory node --env-file=.env test-retention-execute.mjs
//
// GROUP: uses a throwaway group owned by gmail-14. gmail-14 must OWN it (so it can
// set retention) AND be a member (so it can upload). register_group makes the
// owner the first member, so a fresh group satisfies both.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const API_KEY = process.env.NOVA_API_KEY;
const SDK_DIR = process.env.SDK_DIR || '../nova-ai-memory';
const ACCOUNT = 'gmail-14.nova-sdk.near';
// Fresh throwaway group per run — created, used, and left registered-then-cleaned.
const GROUP = 'retention-exec-fixture';

if (!API_KEY) {
  console.error('Set NOVA_API_KEY (gmail-14 key) — needed for the SDK subprocess.');
  process.exit(2);
}

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

// Run a NOVA SDK one-liner as gmail-14 (owner-gated ops the harness can't sign).
function sdk(expr) {
  const code =
    `import pkg from "nova-sdk-js";const {NovaSdk}=pkg;` +
    `const sdk=new NovaSdk("${ACCOUNT}",{apiKey:process.env.NOVA_API_KEY});` +
    `${expr}`;
  return execFileSync('node', ['--input-type=module', '-e', code], {
    cwd: path.resolve(SDK_DIR),
    env: { ...process.env, NOVA_API_KEY: API_KEY },
    encoding: 'utf8',
  }).trim();
}

console.log('\nRetention EXECUTE harness (Piece 3, IRREVERSIBLE)\n');
console.log(`throwaway group: ${GROUP}\n`);

// ── seed (real → ONLINE required) ──
try {
  const { initializeMasterSeed } = await import('./dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const retention = await import('./dist/lib/services/retention.js');
const fastfsSvc = await import('./dist/lib/services/fastfs-storage.js');
const keyMgmt = await import('./dist/lib/services/key-management.js');

// ── SETUP: create a throwaway group, upload one real file into it ──
// register_group via SDK (gmail-14 becomes owner + member). Then upload a file
// through the REAL fastfs service (prepare → client-encrypt → finalize), and
// record it on-chain the way MCP does (record_transaction, backend FastFS).
let fileRef, location, transId;
const PLAINTEXT = Buffer.from(`retention-exec-test payload ${crypto.randomUUID()}`, 'utf8');

await check('setup: ensure group exists + upload a fresh file into it', async () => {
  // 1. ensure the group exists. First run registers it; later runs get
  //    "Group exists", which is the expected reusable-fixture state — treat as OK.
  const reg = sdk(
    `try { const r = await sdk.registerGroup("${GROUP}"); console.log("REGISTERED:" + r); }` +
    `catch (e) { if (/exists/i.test(e.message)) console.log("ALREADY_EXISTS"); else throw e; }`
  );
  const regLine = reg.split('\n').pop();
  console.log(`      registerGroup: ${regLine}`);
  if (!/REGISTERED|ALREADY_EXISTS/.test(regLine)) return false;

  // 2. upload via the SDK (real prepare→encrypt→finalize→record_transaction path)
  //    We use the SDK here (not the raw services) so record_transaction runs and
  //    the on-chain tx + tx_meta(backend=FastFS) exist — which is what execute
  //    needs (get_expired_transactions_detailed reads tx_meta).
  const b64 = PLAINTEXT.toString('base64');
  const up = sdk(
    `const b=Buffer.from("${b64}","base64");` +
    `const r=await sdk.upload("${GROUP}", b, "exec-test.txt");` +
    `console.log(JSON.stringify({cid:r.cid,trans_id:r.trans_id,file_hash:r.file_hash}));`
  );
  const parsed = JSON.parse(up.split('\n').pop());
  location = parsed.cid;          // FastFS location
  transId = String(parsed.trans_id).replace(/^"+|"+$/g, '');
  // fileRef = the relativePath inside the location
  const { parseFastfsLocation } = await import('./dist/lib/fastfs.js');
  fileRef = parseFastfsLocation(location).relativePath;
  console.log(`      uploaded: loc=${location.slice(0, 48)}… trans=${transId.slice(0, 12)}`);
  return location.includes('/') && !!transId && !!fileRef;
});

// ── PRECONDITION: the file is retrievable BEFORE deletion (baseline) ──
await check('precondition: file key exists + FastFS serves the bytes (pre-delete)', async () => {
  // getFileKey should succeed (not FILE_DELETED) — proves the key is live.
  const { file_key } = await keyMgmt.getFileKey({
    group_id: GROUP, file_ref: fileRef, account_id: ACCOUNT,
  });
  return typeof file_key === 'string' && file_key.length > 0;
});

// ── set retention 0 so the file is immediately expired ──
await check('set retention window 0 (file becomes expired)', async () => {
  const out = sdk(`console.log(await sdk.setGroupRetention("${GROUP}", 0));`);
  console.log(`      setGroupRetention(0): ${out.split('\n').pop()}`);
  // wait for the on-chain window to be visible via the detailed view path:
  // scan (free public view) should now show the group with retention_days 0.
  return settle(async () => {
    const s = await retention.scanRetention({});
    const g = s.groups.find((x) => x.group_id === GROUP);
    return g && g.retention_days === 0 && g.expired_trans_ids.includes(transId);
  });
});

// ── 1. DRY-RUN: execute WITHOUT confirm → plan only, destroys nothing ──
await check('dry-run (no confirm) reports the plan and destroys NOTHING', async () => {
  const r = await retention.executeRetention({ group_id: GROUP });
  console.log(`      dry-run: confirmed=${r.confirmed} candidates=${r.candidates} destroyed=${r.destroyed_count}`);
  if (r.confirmed !== false || r.destroyed_count !== 0) return false;
  if (!r.results.every((x) => x.destroyed === false)) return false;
  // Prove nothing was destroyed: the file key must STILL be live.
  const { file_key } = await keyMgmt.getFileKey({ group_id: GROUP, file_ref: fileRef, account_id: ACCOUNT });
  return typeof file_key === 'string' && file_key.length > 0;
});

// ── 2. EXECUTE with confirm → destroys, KEY-FIRST ──
await check('execute (confirm:true) destroys the expired file', async () => {
  const r = await retention.executeRetention({ group_id: GROUP, confirm: true });
  console.log(`      execute: confirmed=${r.confirmed} candidates=${r.candidates} destroyed=${r.destroyed_count}`);
  const fileResult = r.results.find((x) => x.trans_id === transId);
  console.log(`      file result: ${JSON.stringify(fileResult)}`);
  return r.confirmed === true && r.destroyed_count >= 1
      && fileResult && fileResult.destroyed === true;
});

// ── 3. UNRECOVERABILITY: the file key is now crypto-shredded ──
await check('post-delete: getFileKey → FILE_DELETED (key crypto-shredded)', async () => {
  // read-your-writes: tombstoneFileKey blocks to finality, so this should be
  // immediate, but settle a couple times for safety against any lag.
  return settle(async () => {
    try {
      await keyMgmt.getFileKey({ group_id: GROUP, file_ref: fileRef, account_id: ACCOUNT });
      return false; // if it RETURNS a key, deletion failed — not yet unrecoverable
    } catch (e) {
      // Expect ApiError FILE_DELETED (404). Any "deleted" signal = unrecoverable.
      return /FILE_DELETED|deleted/i.test(e?.message || String(e));
    }
  }, 10_000, 1_000);
});

// ── 4. on-chain tombstone recorded ──
await check('post-delete: on-chain tx is tombstoned (is_tombstoned true)', async () => {
  const { getRpcUrl } = await import('./dist/lib/config.js');
  const { rpcCallWithRetry } = await import('./dist/lib/kv.js');
  // read-your-writes: the tombstone tx may need a moment to reach finality.
  return settle(async () => {
    const res = await rpcCallWithRetry(getRpcUrl('mainnet'), {
      jsonrpc: '2.0', id: 'ts', method: 'query',
      params: {
        request_type: 'call_function', finality: 'final',
        account_id: 'nova-sdk.near', method_name: 'is_tombstoned',
        args_base64: Buffer.from(JSON.stringify({ trans_id: transId })).toString('base64'),
      },
    });
    // rpcCallWithRetry returns res.data.result = { result: number[], ... }
    const bytes = (res && res.result) ? res.result : null;
    if (!bytes) return false;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) === true;
  }, 10_000, 1_000);
});

// ── CLEANUP: clear the window + deregister the throwaway group ──
await check('cleanup: clear the retention window (leave fixture group in place)', async () => {
  // Clear the window so the fixture is clean for next run. LEAVE the group
  // registered + on-chain (it's the reusable fixture — re-registering costs NEAR).
  // A registered group with no window is a harmless "stale" registry entry the
  // scan correctly skips; next run's setGroupRetention(0) re-arms it.
  const out = sdk(`console.log(await sdk.setGroupRetention("${GROUP}", null));`);
  console.log(`      cleared: ${out.split('\n').pop()}`);
  return true;
});

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nNOTE: reusable fixture group '${GROUP}' stays registered on-chain with`);
console.log(`its now-tombstoned file(s). Next run uploads a fresh file and reuses it —`);
console.log(`no new group registration. Harmless — it's the dedicated test fixture.\n`);
process.exit(fail ? 1 : 0);
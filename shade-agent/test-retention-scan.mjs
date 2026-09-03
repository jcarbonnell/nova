// shade-agent/test-retention-scan.mjs
//
// §6.1 retention SCAN harness (Piece 2, READ-ONLY / dry-run). Proves the REAL
// compiled scanRetention against real KV + real NOVA contract views.
//
// HYBRID design (necessary — see §5.0 boundary):
//   • The scan reads the REGISTRY (KV) and two CONTRACT VIEWS. All read-only.
//   • To create a "group with expired files" it needs an on-chain retention
//     window on orpc-test. That set/clear is OWNER-GATED (owner = gmail-14), and
//     Shade only holds the KV-owner signer (nova-sdk.near) — it CANNOT sign as
//     gmail-14. So the harness shells out to the SDK (which legitimately signs as
//     gmail-14) for set-window-0 and clear, and does everything else natively:
//     registry via the real service, scan via the real service, asserts, cleanup.
//
// orpc-test is the only group with real FastFS files (from the B5 store test);
// retention_days:0 makes "everything past the current block" expired, so
// get_expired_transactions returns those files' tx_ids — a real non-empty report.
//
// PROVES:
//   1. empty/skip: a registered group with NO on-chain window → skipped_reason.
//   2. non-empty:  orpc-test with window 0 → reported with its expired tx_ids.
//   3. RPC-error DISTINCTION (§7.7 fix): a view against a bogus contract → the
//      group carries `error`, NOT skipped_reason — the whole point of viewOrThrow.
//   4. cleanup leaves registry + on-chain as found.
//
// Run from shade-agent/, in the Shade env (real seed + FastNear + KV access):
//   npm run build
//   NOVA_API_KEY=<gmail-14 key> SDK_DIR=../nova-ai-memory node test-retention-scan.mjs
//
// NOVA_API_KEY  — gmail-14's key, for the SDK subprocess (owner-gated set/clear).
// SDK_DIR       — a dir whose node_modules has nova-sdk-js >=1.2.1 (the plugin dir).

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const GROUP = 'orpc-test';
const API_KEY = process.env.NOVA_API_KEY;
const SDK_DIR = process.env.SDK_DIR || '../nova-ai-memory';

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

// Finality-lag poll (same rationale as the registry harness): a just-set on-chain
// window / just-written registry entry lags at finality:'final' on fast RPC.
async function settle(predicate, timeoutMs = 15_000, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Shell out to the SDK (signs as gmail-14) for the owner-gated set/clear window.
// Kept to a one-liner run in SDK_DIR so it resolves that dir's nova-sdk-js.
function sdkSetRetention(days) {
  const arg = days === null ? 'null' : String(days);
  const code =
    `import pkg from "nova-sdk-js";` +
    `const {NovaSdk}=pkg;` +
    `const sdk=new NovaSdk("gmail-14.nova-sdk.near",{apiKey:process.env.NOVA_API_KEY});` +
    `const m=await sdk.setGroupRetention("${GROUP}", ${arg});` +
    `console.log(m);`;
  const out = execFileSync('node', ['--input-type=module', '-e', code], {
    cwd: path.resolve(SDK_DIR),
    env: { ...process.env, NOVA_API_KEY: API_KEY },
    encoding: 'utf8',
  });
  return out.trim().split('\n').pop();
}

console.log('\nRetention scan harness (Piece 2, read-only)\n');

// ── seed (real → ONLINE) ──
try {
  const { initializeMasterSeed } = await import('./dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const svc = await import('./dist/lib/services/retention.js');

// Baseline: registry should be empty (we cleared it in the Piece 1 smoke). If not,
// we still proceed — the assertions target orpc-test specifically.
const baseline = await svc.listRetentionGroups();
console.log(`registry baseline: ${JSON.stringify(baseline)}\n`);

// ── 1. SKIP path: register orpc-test but set NO on-chain window ──
await check('registered group with no on-chain window → skipped_reason (not error)', async () => {
  await svc.registerRetentionGroup({ group_id: GROUP });
  // wait for the registry write to be visible
  if (!(await settle(async () => (await svc.listRetentionGroups()).includes(GROUP)))) return false;
  const scan = await svc.scanRetention({});
  const g = scan.groups.find((x) => x.group_id === GROUP);
  return g && g.retention_days === null && g.expired_trans_ids.length === 0
          && typeof g.skipped_reason === 'string' && g.error === undefined;
});

// ── 2. NON-EMPTY path: set window 0 on-chain (SDK, as gmail-14) → expired files ──
await check('window 0 on orpc-test → scan reports its expired FastFS tx_ids', async () => {
  const setMsg = sdkSetRetention(0);
  console.log(`      SDK set: ${setMsg}`);
  // The SDK's dual-write also registers the group; ensure the on-chain window is
  // visible before scanning (finality lag on get_group_retention).
  const windowVisible = await settle(async () => {
    const scan = await svc.scanRetention({});
    const g = scan.groups.find((x) => x.group_id === GROUP);
    return g && g.retention_days === 0;
  });
  if (!windowVisible) return false;

  const scan = await svc.scanRetention({});
  const g = scan.groups.find((x) => x.group_id === GROUP);
  console.log(`      expired tx_ids: ${g.expired_trans_ids.length}`);
  // orpc-test has real FastFS uploads from B5, so with window 0 the list is > 0.
  return g && g.retention_days === 0 && g.expired_trans_ids.length > 0
          && g.error === undefined && scan.total_expired >= g.expired_trans_ids.length;
});

// ── 3. RPC TRANSPORT FAILURE → THROWS (the §7.7 fix, unit-level) ──
// The seed is already loaded (real RPC) above, so we can point JUST the view call
// at a dead endpoint and assert viewOrThrow THROWS — which is what makes
// scanRetention capture it as `error` rather than a false null-skip. This can't be
// done through scanRetention itself: KV_RPC_URL === NEAR_RPC_URL (config.ts), so a
// dead URL there also kills the seed/registry reads. Testing the view path in
// isolation is the honest way to prove the distinction.
await check('viewOrThrow THROWS on a dead RPC endpoint (§7.7: not a silent null)', async () => {
  let threw = false;
  try {
    await svc.viewOrThrow('http://127.0.0.1:9', 'nova-sdk.near', 'get_group_retention', { group_id: GROUP });
  } catch {
    threw = true;
  }
  return threw;
});

// ── 4. CLEANUP: clear the on-chain window (SDK) + deregister (native) ──
await check('cleanup: clear window (SDK) and deregister → back to baseline', async () => {
  const clrMsg = sdkSetRetention(null);
  console.log(`      SDK clear: ${clrMsg}`);
  await svc.deregisterRetentionGroup({ group_id: GROUP });
  // confirm both halves are clear
  const registryClear = await settle(async () => !(await svc.listRetentionGroups()).includes(GROUP));
  const windowClear = await settle(async () => {
    const scan = await svc.scanRetention({});
    const g = scan.groups.find((x) => x.group_id === GROUP);
    return !g || g.retention_days === null;
  });
  return registryClear && windowClear;
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
// shade-agent/test/test-scheduler-live.mjs
//
// §6.1 Piece 4 — S3.4: LIVE harness for scheduler-live.ts (the wiring), MAINNET.
// Runs REAL ticks of the live scheduler WITHOUT starting it (no timer), so it
// exercises exactly the dependency mappings S3.2 faked:
//   listDueWindows → is_authorized → get_group_owner → signAsOwner(revoke)
//   → rotateGroupKey → completeAccessWindow,   and
//   readRetentionMarker → scanRetention → writeRetentionMarker.
//
// SAFETY:
//   • ACCESS_WINDOWS_NS, RETENTION_REGISTRY_KEY and SCHEDULER_MARKER_KEY are set
//     to THROWAWAY values before any import: the production window list, the
//     production retention registry and the production marker are never touched.
//     With an empty throwaway registry the retention tick destroys NOTHING.
//   • SCHEDULER_ENABLED is forced off; the harness calls tickSweep/tickRetention
//     directly (ticks are not gated by the kill switch — only start() is).
//   • The only on-chain effects: the SDK adds one throwaway member to the fixture
//     group (gmail-14 pays ~0.00001 NEAR), the sweep revokes it as gmail-14 and
//     rotates the fixture group's key (one KV write).
//
// PROVES:
//   L1 kill switch live: SCHEDULER_ENABLED unset ⇒ start() is a no-op.
//   L2 setup: throwaway member added (SDK, as gmail-14) ⇒ is_authorized true.
//   L3 a 1-minute window recorded in the (throwaway) window list.
//   L4 a tick BEFORE expiry changes nothing.
//   L5 a tick AFTER expiry: member revoked as owner, group key rotated, window removed.
//   L6 the next tick has nothing due (idempotent).
//   L7 retention tick (empty throwaway registry): done, marker = today (UTC).
//   L8 a second retention tick: already_done.
//   L9 status: no failures, last sweep did 1, marker reported.
//
// Build first:  npm run build
// Run (shade-agent/, same terminal where NOVA_API_KEY was read with read -rs):
//               export SDK_DIR=../nova-sdk-js
//               node --env-file=.env ./test/test-scheduler-live.mjs
// Takes ~2 minutes (it waits for the 1-minute window to expire).

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Throwaway namespaces BEFORE importing any service (some read env at load) ──
const RUN = crypto.randomUUID();
process.env.ACCESS_WINDOWS_NS = `_access_windows_LIVE_TEST_${RUN}`;
process.env.RETENTION_REGISTRY_KEY = `_retention_registry_LIVE_TEST_${RUN}`;
process.env.SCHEDULER_MARKER_KEY = `_scheduler_marker_LIVE_TEST_${RUN}`;
delete process.env.SCHEDULER_ENABLED;

const API_KEY = process.env.NOVA_API_KEY;
const SDK_DIR = process.env.SDK_DIR || '../nova-sdk-js';
const OWNER = 'gmail-14.nova-sdk.near';
const GROUP = 'retention-exec-fixture';
const CONTRACT = 'nova-sdk.near';

if (!API_KEY) {
  console.error('Set NOVA_API_KEY (gmail-14 key) with read -rs — needed for the SDK subprocess (add member).');
  process.exit(2);
}

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
async function settle(predicate, timeoutMs = 20_000, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── SDK subprocess (same as the S2.3 harness) ──
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

console.log('\nScheduler LIVE harness (S3.4, mainnet)\n');
console.log(`throwaway window namespace: ${process.env.ACCESS_WINDOWS_NS}`);
console.log(`throwaway registry key:     ${process.env.RETENTION_REGISTRY_KEY}`);
console.log(`throwaway marker key:       ${process.env.SCHEDULER_MARKER_KEY}\n`);

try {
  const { initializeMasterSeed } = await import('../dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const live = await import('../dist/lib/services/scheduler-live.js');
const windows = await import('../dist/lib/services/access-windows.js');
const { viewOrThrow } = await import('../dist/lib/services/retention.js');
const keyMgmt = await import('../dist/lib/services/key-management.js');
const { getRpcUrl } = await import('../dist/lib/config.js');

const RPC = getRpcUrl('mainnet');
const MEMBER = `aw-live-${RUN.slice(0, 8)}.near`;
const isAuthorized = async (user_id) =>
  (await viewOrThrow(RPC, CONTRACT, 'is_authorized', { group_id: GROUP, user_id })) === true;
const groupKey = async () =>
  (await keyMgmt.getGroupKey({ group_id: GROUP, account_id: OWNER })).key;
const todayUtc = () => new Date().toISOString().slice(0, 10);

const sched = live.getScheduler();

// ── L1 ──
await check('L1 kill switch live: SCHEDULER_ENABLED unset ⇒ start() is a no-op', async () => {
  const started = live.startScheduler();
  const st = live.getSchedulerStatus();
  return started === false && st.enabled === false && st.running === false;
});

// ── L2 ──
await check(`L2 setup: SDK adds throwaway member ${MEMBER} ⇒ is_authorized true`, async () => {
  const owner = await viewOrThrow(RPC, CONTRACT, 'get_group_owner', { group_id: GROUP });
  console.log(`      fixture owner: ${JSON.stringify(owner)}`);
  if (owner !== OWNER) return false;
  const add = sdk(`console.log(await sdk.addGroupMember("${GROUP}", "${MEMBER}"));`);
  console.log(`      addGroupMember: ${add.split('\n').pop()}`);
  return settle(() => isAuthorized(MEMBER));
});

// ── L3 ──
let expiresAtMs;
await check('L3 a 1-minute window is recorded (throwaway window list)', async () => {
  const r = await windows.setAccessWindow({ group_id: GROUP, member_id: MEMBER, access_minutes: 1 });
  expiresAtMs = r.expires_at_ms;
  console.log(`      expires_at: ${r.expires_at}`);
  const g = await windows.getAccessWindow({ group_id: GROUP, member_id: MEMBER });
  return g.window?.expires_at_ms === expiresAtMs && r.contract_id === CONTRACT;
});

// ── L4 ──
let keyBefore;
await check('L4 a tick BEFORE expiry changes nothing', async () => {
  keyBefore = await groupKey();
  const out = await sched.tickSweep();
  const st = live.getSchedulerStatus().window_sweep;
  return out === 'ran' && st.last_due === 0 && (await isAuthorized(MEMBER))
      && (await windows.getAccessWindow({ group_id: GROUP, member_id: MEMBER })).window !== null;
});

// ── L5 ──
await check('L5 a tick AFTER expiry: revoked as owner, key rotated, window removed', async () => {
  const waitMs = Math.max(0, expiresAtMs - Date.now()) + 2_000;
  console.log(`      waiting ${Math.round(waitMs / 1000)}s for the window to expire…`);
  await sleep(waitMs);
  const out = await sched.tickSweep();
  const st = live.getSchedulerStatus();
  console.log(`      sweep: ${out}  due=${st.window_sweep.last_due} done=${st.window_sweep.last_done} failed=${st.window_sweep.last_failed}`);
  if (st.failures.length) console.log(`      failures: ${JSON.stringify(st.failures)}`);
  if (out !== 'ran' || st.window_sweep.last_done !== 1) return false;
  const revoked = await settle(async () => !(await isAuthorized(MEMBER)));
  const keyAfter = await groupKey();
  const gone = (await windows.getAccessWindow({ group_id: GROUP, member_id: MEMBER })).window === null;
  console.log(`      revoked=${revoked} rotated=${keyAfter !== keyBefore} window_removed=${gone}`);
  return revoked && keyAfter !== keyBefore && gone;
});

// ── L6 ──
await check('L6 the next tick has nothing due (idempotent)', async () => {
  const out = await sched.tickSweep();
  const st = live.getSchedulerStatus().window_sweep;
  return out === 'ran' && st.last_due === 0 && st.last_failed === 0;
});

// ── L7 ──
await check('L7 retention tick (empty throwaway registry): done, marker = today (UTC)', async () => {
  const out = await sched.tickRetention();
  const st = live.getSchedulerStatus().retention_daily;
  console.log(`      retention: ${out}  marker=${st.marker_date}`);
  return out === 'done' && st.marker_date === todayUtc();
});

// ── L8 ──
await check('L8 a second retention tick: already_done', async () =>
  (await sched.tickRetention()) === 'already_done');

// ── L9 ──
await check('L9 status: no failures, last sweep clean, marker reported', async () => {
  const st = live.getSchedulerStatus();
  return st.failures.length === 0 && st.initialized === true && st.running === false
      && st.retention_daily.marker_date === todayUtc();
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
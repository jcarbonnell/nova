// shade-agent/test/test-scheduler.mjs
//
// §6.1 Piece 4 — S3.2: OFFLINE harness for lib/services/scheduler.ts.
//
// Drives the REAL compiled scheduler with a FAKE CLOCK and fake dependencies —
// no KV, no keys, no chain. Every check is deterministic.
//
// PROVES:
//   KILL SWITCH   K1  enabled:false ⇒ start() is a no-op: nothing called, not running.
//                 K2  enabled:true  ⇒ start() runs a first tick immediately; stop() stops.
//   INIT          I1  init failure ⇒ jobs skip (nothing listed/scanned); next tick retries init.
//   SWEEP         W1  not due ⇒ untouched.
//                 W2  due + member ⇒ owner looked up, revoke AS OWNER, rotate, complete — in order.
//                 W3  overlap: a tick while the sweep runs is SKIPPED (not queued).
//                 W4  RESUME: crash between revoke and rotate ⇒ next tick: no second revoke,
//                     still rotates, completes.
//                 W5  revoke races an early revoke ("not a member") ⇒ treated as done.
//                 W6  rotate GROUP_NOT_FOUND ⇒ treated as done.
//                 W7  permanent (OWNER_NOT_CUSTODIAL) ⇒ stuck at once; skipped next tick;
//                     entry NEVER dropped; reported in status.
//                 W8  group without an owner ⇒ stuck at once.
//                 W9  transient failure ⇒ retried each tick; stuck after MAX_ATTEMPTS; then skipped.
//   RETENTION     R1  BOOT CATCH-UP: marker = yesterday ⇒ runs; executes ONLY groups with
//                     expired files; writes today's marker.
//                 R2  marker = today ⇒ already_done; nothing scanned.
//                 R3  the next UTC day (00:00) ⇒ runs again.
//                 R4  partial ⇒ marker NOT written; retry waits 15 min; the retry executes
//                     ONLY the failed group; then done.
//                 R5  bookkeeping_incomplete ⇒ retry; a malformed location ⇒ permanent,
//                     does not block the day.
//                 R6  a group whose scan view failed ⇒ partial (unknown is never "done").
//                 R7  marker write failure ⇒ failed; retry skips already-completed groups.
//                 R8  registry read failure (scan throws) ⇒ failed, marker untouched.
//                 R9  marker read failure ⇒ marker_read_failed; next tick reads it.
//                 R10 overlap: a tick while retention runs is SKIPPED.
//
// MUTATIONS (edit src/lib/services/scheduler.ts, rebuild, rerun, revert).
// Each must make exactly the named check(s) fail; everything else passes:
//   M1 rotate-always   `      try {\n        await deps.rotateKey(w);`
//                      → `      if (wasMember) try { // MUTATION M1\n        await deps.rotateKey(w);`
//                      → fails W4, W9 (a non-member is never rotated)
//   M2 sweep overlap   `if (sweepRunning) return 'skipped_overlap';`
//                      → `if (sweepRunning && Date.now() < 0) return 'skipped_overlap';`
//                      → fails W3
//   M3 daily marker    `if (markerDate === today) return 'already_done';`
//                      → `if (markerDate === today && Date.now() < 0) return 'already_done';`
//                      → fails R2, R2b, R3 (runs on every tick)
//   M4 kill switch     `if (!options.enabled) {`
//                      → `if (!options.enabled && Date.now() < 0) {`
//                      → fails K1
//   M6 retention overlap `if (retentionRunning) return 'skipped_overlap';`
//                      → `if (retentionRunning && Date.now() < 0) return 'skipped_overlap';`
//                      → fails R10
//   M5 stuck skip      `if (failures.get(windowKey(w))?.stuck) { skippedStuck++; continue; }`
//                      → `if (failures.get(windowKey(w))?.stuck && Date.now() < 0) { skippedStuck++; continue; }`
//                      → fails W7 / W9 (stuck entries retried forever)
//
// Build first:  npm run build
// Run:          node ./test/test-scheduler.mjs        (no .env, no network needed)

const S = await import('../dist/lib/services/scheduler.js');
const { createScheduler, MAX_ATTEMPTS, RETENTION_RETRY_MS } = S;

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};

// Quiet the scheduler's JSON log lines unless VERBOSE=1 (they go to stdout).
const realLog = console.log;
const quiet = !process.env.VERBOSE;
const say = (...a) => realLog(...a);
if (quiet) console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"')) return; realLog(...a); };

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 26, 10, 0, 0);       // 2026-10-26 10:00 UTC
const TODAY = '2026-10-26', YESTERDAY = '2026-10-25', TOMORROW = '2026-10-27';
const C = 'nova-sdk.near';
const OWNER = 'owner.nova-sdk.near';

const coded = (code, msg = code) => Object.assign(new Error(msg), { code });
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }
// A tick that is NOT skipped would block on the held dependency; race it against
// a short timer so a broken overlap guard fails the check instead of hanging the run.
const orBlocked = (p, ms = 100) => Promise.race([p, new Promise((r) => setTimeout(() => r('blocked'), ms))]);

// A fake world + deps. `fail[name]` = function(arg) returning an Error to throw (or undefined).
function world(over = {}) {
  const w = {
    clock: T0,
    windows: [],
    members: new Set(),
    owners: { g1: OWNER, g2: OWNER },
    calls: [],
    fail: {},
    holdList: null,
    holdScan: null,
    marker: YESTERDAY,
    scan: { scanned_at: '', registry_size: 0, groups: [], total_expired: 0 },
    exec: {},
    ...over,
  };
  const mk = (x) => `${x.group_id}|${x.member_id}`;
  const maybe = (name, arg) => { const f = w.fail[name]; const e = f && f(arg); if (e) throw e; };
  w.deps = {
    now: () => w.clock,
    init: async () => { w.calls.push('init'); maybe('init'); },
    listDueWindows: async (now) => {
      w.calls.push('list');
      if (w.holdList) await w.holdList.p;
      maybe('list');
      return { groups: 1, due: w.windows.filter((x) => x.expires_at_ms <= now), errors: [] };
    },
    isMember: async (x) => { w.calls.push(`isMember:${x.member_id}`); maybe('isMember', x); return w.members.has(mk(x)); },
    groupOwner: async (x) => { w.calls.push(`owner:${x.group_id}`); return w.owners[x.group_id] ?? null; },
    revokeAsOwner: async (owner, x) => {
      w.calls.push(`revoke:${owner}:${x.member_id}`);
      maybe('revoke', x);
      if (!w.members.has(mk(x))) throw new Error('Contract execution failed: Smart contract panicked: User not a member');
      w.members.delete(mk(x));
    },
    rotateKey: async (x) => { w.calls.push(`rotate:${x.group_id}`); maybe('rotate', x); },
    completeWindow: async (x) => {
      w.calls.push(`complete:${x.member_id}`);
      maybe('complete', x);
      w.windows = w.windows.filter((y) => !(y.group_id === x.group_id && y.member_id === x.member_id && y.expires_at_ms === x.expires_at_ms));
      return { removed: true };
    },
    scanRetention: async () => {
      w.calls.push('scan');
      if (w.holdScan) await w.holdScan.p;
      maybe('scan');
      return w.scan;
    },
    executeRetention: async (g) => {
      w.calls.push(`exec:${g}`);
      const r = typeof w.exec[g] === 'function' ? w.exec[g]() : w.exec[g];
      if (r instanceof Error) throw r;
      return r;
    },
    readRetentionMarker: async () => { w.calls.push('readMarker'); maybe('readMarker'); return w.marker; },
    writeRetentionMarker: async (d) => { w.calls.push(`writeMarker:${d}`); maybe('writeMarker'); w.marker = d; },
  };
  w.addWindow = (group_id, member_id, expires_at_ms, isMember = true) => {
    w.windows.push({ contract_id: C, group_id, member_id, expires_at_ms });
    if (isMember) w.members.add(`${group_id}|${member_id}`);
  };
  w.sched = (opts = {}) => createScheduler(w.deps, { enabled: true, tickMs: 3_600_000, ...opts });
  return w;
}

const okExec = (g, n) => ({
  group_id: g, confirmed: true, candidates: n, destroyed_count: n,
  results: Array.from({ length: n }, (_, i) => ({ trans_id: `${g}-t${i}`, location: `a/b/${g}${i}`, destroyed: true })),
});
const grp = (group_id, retention_days, expired = [], error) =>
  ({ group_id, retention_days, expired_trans_ids: expired, ...(error ? { error } : {}) });
const only = (calls, prefix) => calls.filter((c) => c.startsWith(prefix));

say('\nScheduler OFFLINE harness (S3.2)\n');

// ── KILL SWITCH ─────────────────────────────────────────────────────────────
say('KILL SWITCH:');

await check('K1 enabled:false ⇒ start() is a no-op (nothing called, not running)', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  const s = w.sched({ enabled: false });
  const started = s.start();
  await new Promise((r) => setTimeout(r, 20));
  const st = s.getStatus();
  s.stop();
  return started === false && w.calls.length === 0 && st.running === false && st.enabled === false
      && w.windows.length === 1;
});

await check('K2 enabled:true ⇒ start() ticks immediately (sweep + retention); stop() stops', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  w.scan.groups = [grp('g1', null)];
  const s = w.sched();
  const started = s.start();
  await new Promise((r) => setTimeout(r, 30));
  const running = s.getStatus().running;
  s.stop();
  return started === true && running === true && s.getStatus().running === false
      && w.calls.includes('list') && w.calls.includes('scan') && w.windows.length === 0;
});

// ── INIT ────────────────────────────────────────────────────────────────────
say('\nINIT:');

await check('I1 init failure ⇒ both jobs skip; next tick retries init and runs', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  let failInit = true;
  w.fail.init = () => (failInit ? new Error('KV unreachable') : undefined);
  const s = w.sched();
  const a = await s.tickSweep();
  const b = await s.tickRetention();
  const nothing = !w.calls.includes('list') && !w.calls.includes('scan');
  failInit = false;
  const c = await s.tickSweep();
  return a === 'skipped_not_initialized' && b === 'skipped_not_initialized' && nothing
      && c === 'ran' && w.windows.length === 0 && s.getStatus().initialized === true;
});

// ── SWEEP ───────────────────────────────────────────────────────────────────
say('\nWINDOW SWEEP:');

await check('W1 not due ⇒ untouched (no membership check, entry kept)', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 + MIN);
  const s = w.sched();
  const r = await s.tickSweep();
  return r === 'ran' && only(w.calls, 'isMember').length === 0 && w.windows.length === 1
      && w.members.has('g1|buyer-a');
});

await check('W2 due + member ⇒ owner lookup, revoke AS OWNER, rotate, complete (in that order)', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 + MIN);
  const s = w.sched();
  await s.tickSweep();                       // not due yet
  w.clock = T0 + MIN;                        // exactly at expiry ⇒ due
  const r = await s.tickSweep();
  const seq = w.calls.filter((c) => !['init', 'list'].includes(c));
  const want = ['isMember:buyer-a', 'owner:g1', `revoke:${OWNER}:buyer-a`, 'rotate:g1', 'complete:buyer-a'];
  const st = s.getStatus().window_sweep;
  return r === 'ran' && JSON.stringify(seq) === JSON.stringify(want)
      && !w.members.has('g1|buyer-a') && w.windows.length === 0
      && st.last_due === 1 && st.last_done === 1 && st.last_failed === 0;
});

await check('W3 overlap: a tick while the sweep is running is SKIPPED, not queued', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  w.holdList = deferred();
  const s = w.sched();
  const first = s.tickSweep();
  await new Promise((r) => setTimeout(r, 10));
  const second = await orBlocked(s.tickSweep());
  const listedWhileHeld = only(w.calls, 'list').length;
  w.holdList.resolve();
  const firstOut = await first;
  return second === 'skipped_overlap' && firstOut === 'ran' && listedWhileHeld === 1;
});

await check('W4 RESUME: crash between revoke and rotate ⇒ next tick: no 2nd revoke, rotates, completes', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  let crash = true;
  w.fail.rotate = () => (crash ? new Error('process died / RPC timeout') : undefined);
  const s = w.sched();
  await s.tickSweep();                        // revoke lands, rotate throws
  const afterFirst = { revoked: !w.members.has('g1|buyer-a'), kept: w.windows.length === 1,
                       attempts: s.getStatus().failures[0]?.attempts };
  crash = false;
  w.clock += MIN;
  await s.tickSweep();                        // resume
  return afterFirst.revoked && afterFirst.kept && afterFirst.attempts === 1
      && only(w.calls, 'revoke').length === 1 && only(w.calls, 'rotate').length === 2
      && w.windows.length === 0 && s.getStatus().failures.length === 0;
});

await check('W5 revoke races an early revoke ("not a member") ⇒ treated as done', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  // is_authorized still says member, but by the time the revoke lands the owner already revoked.
  w.fail.revoke = (x) => { w.members.delete(`${x.group_id}|${x.member_id}`); return undefined; };
  const s = w.sched();
  await s.tickSweep();
  return only(w.calls, 'rotate').length === 1 && w.windows.length === 0 && s.getStatus().failures.length === 0;
});

await check('W6 rotate GROUP_NOT_FOUND ⇒ treated as done (entry completed, no failure)', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN, false);
  w.fail.rotate = () => coded('GROUP_NOT_FOUND', 'Group not found (nova-sdk.near)');
  const s = w.sched();
  await s.tickSweep();
  return w.windows.length === 0 && s.getStatus().failures.length === 0 && only(w.calls, 'revoke').length === 0;
});

await check('W7 permanent (OWNER_NOT_CUSTODIAL) ⇒ stuck at once; skipped next tick; entry never dropped', async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  w.fail.revoke = () => coded('OWNER_NOT_CUSTODIAL', 'Account is wallet-owned');
  const s = w.sched();
  await s.tickSweep();
  const f1 = s.getStatus().failures[0];
  w.clock += MIN;
  await s.tickSweep();
  const st = s.getStatus();
  return f1?.stuck === true && f1.attempts === 1
      && only(w.calls, 'isMember').length === 1          // second tick did not touch it
      && st.window_sweep.last_skipped_stuck === 1
      && w.windows.length === 1 && w.members.has('g1|buyer-a');
});

await check('W8 group without an owner ⇒ stuck at once', async () => {
  const w = world({ owners: {} });
  w.addWindow('g1', 'buyer-a', T0 - MIN);
  const s = w.sched();
  await s.tickSweep();
  const f = s.getStatus().failures[0];
  return f?.stuck === true && f.attempts === 1 && only(w.calls, 'revoke').length === 0 && w.windows.length === 1;
});

await check(`W9 transient failure ⇒ retried each tick; stuck after ${MAX_ATTEMPTS}; then skipped`, async () => {
  const w = world();
  w.addWindow('g1', 'buyer-a', T0 - MIN, false);
  w.fail.rotate = () => new Error('RPC error: Server error');
  const s = w.sched();
  const stuckAt = [];
  for (let i = 1; i <= MAX_ATTEMPTS + 2; i++) {
    await s.tickSweep();
    stuckAt.push(s.getStatus().failures[0]?.stuck);
    w.clock += MIN;
  }
  const f = s.getStatus().failures[0];
  return f.attempts === MAX_ATTEMPTS && f.stuck === true
      && stuckAt[MAX_ATTEMPTS - 2] === false && stuckAt[MAX_ATTEMPTS - 1] === true
      && only(w.calls, 'rotate').length === MAX_ATTEMPTS
      && w.windows.length === 1
      && s.getStatus().window_sweep.overdue.length === 1;
});

// ── RETENTION ───────────────────────────────────────────────────────────────
say('\nDAILY RETENTION:');

await check('R1 BOOT CATCH-UP: marker=yesterday ⇒ runs; executes ONLY groups with expired files; marker=today', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1', 't2']), grp('gB', null), grp('gC', 7, [])];
  w.exec.gA = okExec('gA', 2);
  const s = w.sched();
  const r = await s.tickRetention();
  return r === 'done' && w.marker === TODAY
      && JSON.stringify(only(w.calls, 'exec')) === '["exec:gA"]'
      && s.getStatus().retention_daily.last_destroyed === 2;
});

await check('R2 marker=today ⇒ already_done; nothing scanned', async () => {
  const w = world({ marker: TODAY });
  w.scan.groups = [grp('gA', 30, ['t1'])];
  w.exec.gA = okExec('gA', 1);
  const s = w.sched();
  const r = await s.tickRetention();
  return r === 'already_done' && !w.calls.includes('scan') && only(w.calls, 'exec').length === 0;
});

await check('R2b same day, after a completed run ⇒ already_done on every later tick', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1'])];
  w.exec.gA = okExec('gA', 1);
  const s = w.sched();
  const a = await s.tickRetention();
  w.clock += 30 * MIN;
  const b = await s.tickRetention();
  w.clock += 5 * 60 * MIN;
  const c = await s.tickRetention();
  return a === 'done' && b === 'already_done' && c === 'already_done' && only(w.calls, 'scan').length === 1;
});

await check('R3 the next UTC day (00:00) ⇒ runs again and writes the new date', async () => {
  const w = world({ marker: TODAY });
  w.scan.groups = [grp('gA', 30, ['t9'])];
  w.exec.gA = okExec('gA', 1);
  const s = w.sched();
  const a = await s.tickRetention();                        // today: already done
  w.clock = Date.UTC(2026, 9, 26, 23, 59, 0);
  const b = await s.tickRetention();                        // 23:59: still today
  w.clock = Date.UTC(2026, 9, 27, 0, 0, 30);                // 00:00:30 tomorrow
  const c = await s.tickRetention();
  return a === 'already_done' && b === 'already_done' && c === 'done' && w.marker === TOMORROW
      && only(w.calls, 'exec').length === 1;
});

await check('R4 partial ⇒ no marker; retry waits 15 min; retry executes ONLY the failed group; then done', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1']), grp('gB', 30, ['t2'])];
  w.exec.gA = okExec('gA', 1);
  let gBfails = true;
  w.exec.gB = () => (gBfails ? new Error('RPC error: Server error') : okExec('gB', 1));
  const s = w.sched();
  const a = await s.tickRetention();
  const markerAfterA = w.marker;
  w.clock += MIN;
  const b = await s.tickRetention();                        // 1 min later: waiting
  gBfails = false;
  w.clock = T0 + RETENTION_RETRY_MS;                        // 15 min after the attempt
  const c = await s.tickRetention();
  const execs = only(w.calls, 'exec');
  return a === 'partial' && markerAfterA === YESTERDAY && b === 'waiting_retry'
      && c === 'done' && w.marker === TODAY
      && JSON.stringify(execs) === '["exec:gA","exec:gB","exec:gB"]'
      && only(w.calls, 'scan').length === 2;
});

await check('R5 bookkeeping_incomplete ⇒ retry; malformed location ⇒ permanent, does not block the day', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1']), grp('gB', 30, ['t2'])];
  w.exec.gA = { group_id: 'gA', confirmed: true, candidates: 1, destroyed_count: 1,
                results: [{ trans_id: 't1', location: 'x', destroyed: true, bookkeeping_incomplete: true, error: 'on-chain tombstone failed' }] };
  w.exec.gB = { group_id: 'gB', confirmed: true, candidates: 1, destroyed_count: 0,
                results: [{ trans_id: 't2', location: 'legacy', destroyed: false, error: 'bad location: not a FastFS path' }] };
  const s = w.sched();
  const a = await s.tickRetention();
  const failed = s.getStatus().retention_daily.last_failed_groups;
  w.exec.gA = okExec('gA', 1);
  w.clock += RETENTION_RETRY_MS;
  const b = await s.tickRetention();
  return a === 'partial' && JSON.stringify(failed) === '["gA"]'
      && b === 'done' && w.marker === TODAY
      && JSON.stringify(only(w.calls, 'exec')) === '["exec:gA","exec:gB","exec:gA"]';
});

await check('R6 a group whose scan view failed ⇒ partial (unknown is never "done")', async () => {
  const w = world();
  w.scan.groups = [grp('gA', null, [], 'RPC error: timeout')];
  const s = w.sched();
  const r = await s.tickRetention();
  return r === 'partial' && w.marker === YESTERDAY && only(w.calls, 'exec').length === 0;
});

await check('R7 marker write failure ⇒ failed; the retry skips already-completed groups', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1'])];
  w.exec.gA = okExec('gA', 1);
  let failWrite = true;
  w.fail.writeMarker = () => (failWrite ? new Error('KV write failed') : undefined);
  const s = w.sched();
  const a = await s.tickRetention();
  failWrite = false;
  w.clock += RETENTION_RETRY_MS;
  const b = await s.tickRetention();
  return a === 'failed' && b === 'done' && w.marker === TODAY && only(w.calls, 'exec').length === 1;
});

await check('R8 registry read failure (scan throws) ⇒ failed; marker untouched', async () => {
  const w = world();
  w.fail.scan = () => new Error('RPC error: KV read');
  const s = w.sched();
  const r = await s.tickRetention();
  return r === 'failed' && w.marker === YESTERDAY && !w.calls.some((c) => c.startsWith('writeMarker'));
});

await check('R9 marker read failure ⇒ marker_read_failed (no scan); next tick reads it and runs', async () => {
  const w = world();
  w.scan.groups = [grp('gA', null)];
  let failRead = true;
  w.fail.readMarker = () => (failRead ? new Error('RPC error') : undefined);
  const s = w.sched();
  const a = await s.tickRetention();
  const scannedA = w.calls.includes('scan');
  failRead = false;
  const b = await s.tickRetention();
  return a === 'marker_read_failed' && !scannedA && b === 'done' && w.marker === TODAY;
});

await check('R10 overlap: a tick while retention is running is SKIPPED', async () => {
  const w = world();
  w.scan.groups = [grp('gA', 30, ['t1'])];
  w.exec.gA = okExec('gA', 1);
  w.holdScan = deferred();
  const s = w.sched();
  const first = s.tickRetention();
  await new Promise((r) => setTimeout(r, 10));
  const second = await orBlocked(s.tickRetention());
  const scannedWhileHeld = only(w.calls, 'scan').length;
  w.holdScan.resolve();
  const firstOut = await first;
  return second === 'skipped_overlap' && firstOut === 'done' && scannedWhileHeld === 1;
});

console.log = realLog;
say(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

// shade-agent/test-access-windows.mjs
//
// §6.1 Piece 4 — S1 ACCESS-WINDOW STORE harness. Proves the REAL compiled
// lib/services/access-windows.ts against REAL KV, under a THROWAWAY namespace
// (ACCESS_WINDOWS_NS), never the production 'access-windows' blobs.
//
// PROVES:
//   1. set / get / upsert / clear (idempotent) / persistence across a simulated
//      restart (_resetAccessWindowCache → reload from KV).
//   2. back-to-back writes inside the finality-lag window keep BOTH (the cache).
//   3. concurrent writes keep BOTH (the lock).
//   4. an RPC failure on the read ABORTS the write (the strict reader).
//   5. completeAccessWindow spares a window replaced mid-sweep.
//   6. an emptied group leaves the index; a corrupt blob THROWS (get + set) and
//      the sweep reports it instead of skipping it.
//
// MUTATIONS (each must make its named check fail; others may fail too):
//   M1 cache  — in loadGroup delete `if (cached) return cached;`
//               → fails "back-to-back set keeps both members across a restart"
//   M2 lock   — replace withLock's body with `return fn();`
//               → fails "concurrent sets on a fresh group keep both"
//   M3 strict — in loadGroup use `getBlobFromKVStrict(...).catch(() => null)`
//               → fails "RPC failure on the group read aborts set"
//
// Build first:  npm run build
// Run:          node --env-file=.env test-access-windows.mjs

import crypto from 'node:crypto';

// Throwaway namespace — set BEFORE importing the service (read at module load).
const NS = `_access_windows_TEST_${crypto.randomUUID()}`;
process.env.ACCESS_WINDOWS_NS = NS;

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

console.log('\nAccess-window store harness (§6.1 Piece 4, S1)\n');
console.log(`test namespace: ${NS}\n`);

try {
  const { initializeMasterSeed } = await import('../dist/lib/seed.js');
  await initializeMasterSeed();
  console.log('seed: real master seed loaded\n');
} catch (e) {
  console.error(`FATAL: need the real Shade env (seed/KV): ${e?.message || e}`);
  process.exit(2);
}

const svc = await import('../dist/lib/services/access-windows.js');
const { storeBlobToKV } = await import('../dist/lib/kv.js');
const { encryptBlob, sha256Hex } = await import('../dist/lib/crypto.js');
const axios = (await import('axios')).default;

const u = () => crypto.randomUUID().slice(0, 8);
const G1 = `aw-g1-${u()}`, G2 = `aw-g2-${u()}`, G3 = `aw-g3-${u()}`;
const A = `buyer-a-${u()}.near`, B = `buyer-b-${u()}.near`, C = `buyer-c-${u()}.near`;
const D = `buyer-d-${u()}.near`, E = `buyer-e-${u()}.near`, F = `buyer-f-${u()}.near`;
const FAR = () => Date.now() + 2 * 365 * 24 * 60 * 60_000;

const restart = () => svc._resetAccessWindowCache();
const get = (group_id, member_id) => svc.getAccessWindow({ group_id, member_id });
let contractId;

// ── 1. empty namespace ──
await check('unwritten namespace: get → null, nothing due, no errors', async () => {
  const g = await get(G1, A);
  const d = await svc.listDueWindows(FAR());
  return g.window === null && d.groups === 0 && d.due.length === 0 && d.errors.length === 0;
});

// ── 2. set ──
await check('set records a window ~60 min out', async () => {
  const t0 = Date.now();
  const r = await svc.setAccessWindow({ group_id: G1, member_id: A, access_minutes: 60 });
  contractId = r.contract_id;
  const delta = r.expires_at_ms - t0;
  return r.set === true && typeof contractId === 'string'
      && delta >= 60 * 60_000 && delta < 60 * 60_000 + 30_000;
});

// ── 3. back-to-back inside the finality lag (M1: cache) ──
await check('back-to-back set keeps both members across a restart (cache)', async () => {
  await svc.setAccessWindow({ group_id: G1, member_id: B, access_minutes: 60 });
  return settle(async () => {
    restart();
    return !!(await get(G1, A)).window && !!(await get(G1, B)).window;
  });
});

// ── 4. concurrent (M2: lock) ──
await check('concurrent sets on a fresh group keep both (lock)', async () => {
  await Promise.all([
    svc.setAccessWindow({ group_id: G2, member_id: C, access_minutes: 30 }),
    svc.setAccessWindow({ group_id: G2, member_id: D, access_minutes: 30 }),
  ]);
  return settle(async () => {
    restart();
    return !!(await get(G2, C)).window && !!(await get(G2, D)).window;
  });
});

// ── 5. RPC failure on the group read (M3: strict) ──
// Inject a failure ONLY on the KV read of G1's blob (index read + writes pass),
// after a restart so loadGroup must hit KV.
await check('RPC failure on the group read aborts set (strict)', async () => {
  const g1Key = sha256Hex(`${NS}:${contractId}:${G1}`);
  const origPost = axios.post;
  let threw = false;
  restart();
  axios.post = async (url, payload, cfg) => {
    if (payload?.method === 'query' && payload?.params?.method_name === 'get') {
      const args = JSON.parse(Buffer.from(payload.params.args_base64, 'base64').toString('utf8'));
      if (args.key === g1Key) throw new Error('injected: KV group read RPC failure');
    }
    return origPost.call(axios, url, payload, cfg);
  };
  try {
    await svc.setAccessWindow({ group_id: G1, member_id: E, access_minutes: 60 });
  } catch {
    threw = true;
  } finally {
    axios.post = origPost;
  }
  if (!threw) return false;
  return settle(async () => {
    restart();
    return !!(await get(G1, A)).window && !!(await get(G1, B)).window
        && (await get(G1, E)).window === null;
  }, 5_000);
});

// ── 6. upsert ──
await check('upsert replaces one member window; others untouched', async () => {
  const bBefore = (await get(G1, B)).window.expires_at_ms;
  const r = await svc.setAccessWindow({ group_id: G1, member_id: A, access_minutes: 5 });
  const a = (await get(G1, A)).window;
  const b = (await get(G1, B)).window;
  return a.expires_at_ms === r.expires_at_ms && b.expires_at_ms === bBefore
      && r.expires_at_ms < Date.now() + 6 * 60_000;
});

// ── 7. due listing ──
await check('listDueWindows: nothing due now; all four due far in the future', async () => {
  const now = await svc.listDueWindows(Date.now());
  const later = await svc.listDueWindows(FAR());
  const keys = later.due.map((d) => `${d.group_id}|${d.member_id}`).sort();
  const want = [`${G1}|${A}`, `${G1}|${B}`, `${G2}|${C}`, `${G2}|${D}`].sort();
  return now.due.length === 0 && later.errors.length === 0
      && JSON.stringify(keys) === JSON.stringify(want);
});

// ── 8. complete spares a replaced window ──
await check('completeAccessWindow spares a window replaced mid-sweep, then removes the current one', async () => {
  const stale = (await svc.listDueWindows(FAR())).due.find((d) => d.group_id === G1 && d.member_id === A);
  await svc.setAccessWindow({ group_id: G1, member_id: A, access_minutes: 10 }); // re-added mid-sweep
  const r1 = await svc.completeAccessWindow(stale);
  if (r1.removed !== false || r1.reason !== 'replaced') return false;
  if (!(await get(G1, A)).window) return false;
  const cur = (await svc.listDueWindows(FAR())).due.find((d) => d.group_id === G1 && d.member_id === A);
  const r2 = await svc.completeAccessWindow(cur);
  return r2.removed === true && (await get(G1, A)).window === null;
});

// ── 9. clear + index pruning ──
await check('clear is idempotent; an emptied group leaves the index (after restart)', async () => {
  const r1 = await svc.clearAccessWindow({ group_id: G1, member_id: B });
  const r2 = await svc.clearAccessWindow({ group_id: G1, member_id: B });
  if (!(r1.was_present === true && r2.was_present === false)) return false;
  return settle(async () => {
    restart();
    const d = await svc.listDueWindows(FAR());
    return d.groups === 1 && d.due.length === 2 && d.due.every((x) => x.group_id === G2);
  });
});

// ── 10. corrupt blob ──
await check('corrupt group blob THROWS on get and set; the sweep reports it, other groups still listed', async () => {
  await svc.setAccessWindow({ group_id: G3, member_id: F, access_minutes: 30 }); // G3 into the index
  await storeBlobToKV(
    sha256Hex(`${NS}:${contractId}:${G3}`),
    encryptBlob(Buffer.from(JSON.stringify({ not: 'valid' }), 'utf8')),
  );
  const seen = await settle(async () => {
    restart();
    try { await get(G3, F); return false; }
    catch (e) { return /unreadable|CORRUPT/i.test(e?.message || String(e)); }
  });
  if (!seen) return false;
  let setThrew = false;
  try { await svc.setAccessWindow({ group_id: G3, member_id: E, access_minutes: 30 }); }
  catch { setThrew = true; }
  const d = await svc.listDueWindows(FAR());
  return setThrew && d.errors.some((x) => x.group_id === G3)
      && d.due.filter((x) => x.group_id === G2).length === 2;
});

// ── cleanup (throwaway namespace; G3 stays corrupt — harmless, never read in prod) ──
await check('cleanup: clear G2 members', async () => {
  await svc.clearAccessWindow({ group_id: G2, member_id: C });
  await svc.clearAccessWindow({ group_id: G2, member_id: D });
  return true;
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
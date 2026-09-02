// shade-agent/test-retention-registry.mjs
//
// §6.1 retention-REGISTRY harness (Piece 1). Proves the REAL compiled
// lib/services/retention.ts against KV.
//
//   OFFLINE (no network): none — the registry logic is pure read-modify-write
//     over KV, so there is nothing seed/crypto-independent to assert alone.
//   ONLINE (mainnet, real signer — needs Shade env: TEE_KEY_SECRET + KV access):
//     the full add/remove/idempotency/superset-invariant semantics against REAL
//     KV, under a THROWAWAY registry key (RETENTION_REGISTRY_KEY), never the
//     production 'retention-registry' singleton.
//
// Why real KV + real service (not an in-memory stub + transcription, à la the
// api-key harness): the byte-level crypto here is already proven by
// test-lib-extraction. The risk in THIS piece is the read-modify-write logic in
// the SERVICE — union on add, filter on remove, idempotency, and the
// registry ⊇ on-chain invariant's write ordering. A transcription wouldn't test
// the real service; importing it does. We keep production safe the fastfs-step1
// way: a throwaway key, not a stub.
//
// Build first (in shade-agent):  npm run build
// Run:                           node test-retention-registry.mjs
// Signs as nova-sdk.near (kv-owner-signer-v1); a few sub-cent KV writes.

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// Throwaway, per-run registry key — set BEFORE importing the service, which
// reads it at module load. Never the production 'retention-registry'.
const TEST_KEY = `_retention_registry_TEST_${crypto.randomUUID()}`;
process.env.RETENTION_REGISTRY_KEY = TEST_KEY;

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  \u2713 ${name}`))
                     : (fail++, console.log(`  \u2717 ${name}`)); }
  catch (e) { fail++; console.log(`  \u2717 ${name} — threw: ${e?.message || e}`); }
};

// Finality-lag poll. getBlobFromKV reads at finality:'final', which lags a just-
// committed write by ~1-2s. On the public RPC every read already took ~3s so the
// lag was always absorbed; on FastNear (~100ms reads) a post-write readback can
// outrun finality and see stale state. This is a HARNESS-only concern: in
// production the registry is written by MCP's set_group_retention and read by the
// driver minutes+ later — never write-then-immediate-read. So the TEST waits, the
// SERVICE does not block (mirrors the §10 FastFS file-meta decision: pay finality
// latency only on the rare high-stakes deletion path, not on ordinary reads).
// Polls the predicate until true or the deadline; returns the predicate's result.
async function settle(predicate, timeoutMs = 15_000, everyMs = 1_000) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

console.log('\nRetention registry harness (Piece 1)\n');
console.log(`test registry key: ${TEST_KEY}\n`);

// ── Seed: real seed enables the ONLINE (real-KV) run. Without it, skip. ──
let haveRealSeed = false;
try {
  const { initializeMasterSeed } = await import('./dist/lib/seed.js');
  await initializeMasterSeed();
  haveRealSeed = true;
  console.log('seed: real master seed loaded (ONLINE enabled)\n');
} catch (e) {
  console.log(`seed: none — ONLINE skipped (run in the Shade env with TEE_KEY_SECRET + KV access): ${e?.message || e}\n`);
}

if (haveRealSeed) {
  console.log('ONLINE (real service, real KV, throwaway key):');

  const svc = await import('./dist/lib/services/retention.js');
  const { getBlobFromKV, storeBlobToKV } = await import('./dist/lib/kv.js');
  const { encryptBlob } = await import('./dist/lib/crypto.js');

  // Ensure a clean slate: the throwaway key is fresh per run (uuid), so KV has
  // no blob for it yet. Confirm the "never written" read path returns [].
  await check('empty registry (unwritten key) lists as []', async () => {
    const list = await svc.listRetentionGroups();
    return Array.isArray(list) && list.length === 0;
  });

  const g1 = `grp-${crypto.randomUUID()}`;
  const g2 = `grp-${crypto.randomUUID()}`;

  await check('register adds a group', async () => {
    const r = await svc.registerRetentionGroup({ group_id: g1 });
    if (r.registered !== true || r.already_present !== false) return false;
    // wait for finality before asserting the readback sees g1
    return settle(async () => (await svc.listRetentionGroups()).includes(g1));
  });

  await check('register is idempotent (already_present, size unchanged)', async () => {
    // g1 already registered above; a fresh read should see it (settle for finality)
    if (!(await settle(async () => (await svc.listRetentionGroups()).includes(g1)))) return false;
    const before = (await svc.listRetentionGroups()).length;
    const r = await svc.registerRetentionGroup({ group_id: g1 });
    const after = (await svc.listRetentionGroups()).length;
    return r.registered === true && r.already_present === true && before === after;
  });

  await check('a second register adds without dropping the first (set union)', async () => {
    await svc.registerRetentionGroup({ group_id: g2 });
    return settle(async () => {
      const list = await svc.listRetentionGroups();
      return list.includes(g1) && list.includes(g2);
    });
  });

  await check('deregister removes only the named group', async () => {
    const r = await svc.deregisterRetentionGroup({ group_id: g1 });
    if (r.deregistered !== true || r.was_present !== true) return false;
    return settle(async () => {
      const list = await svc.listRetentionGroups();
      return !list.includes(g1) && list.includes(g2);
    });
  });

  await check('deregister is idempotent (was_present false for absent group)', async () => {
    // g1 already removed above; ensure finality reflects that before re-deregistering
    if (!(await settle(async () => !(await svc.listRetentionGroups()).includes(g1)))) return false;
    const r = await svc.deregisterRetentionGroup({ group_id: g1 });
    return r.deregistered === true && r.was_present === false;
  });

  // The blob is REAL KV + REAL crypto: prove it survived encrypt→store→get→decrypt
  // by reading it back through the service one more time (g2 should persist).
  await check('registry blob round-trips through real KV + real crypto', async () => {
    return settle(async () => {
      const list = await svc.listRetentionGroups();
      return list.length === 1 && list[0] === g2;
    });
  });

  // Superset-invariant intent: a corrupt/garbage blob must not crash the driver's
  // read — readRegistry returns [] on a non-array. Simulate by writing junk to the
  // test key directly, then reading through the service.
  await check('non-array blob reads as [] (driver-safe), not a throw', async () => {
    await storeBlobToKV(TEST_KEY, encryptBlob(Buffer.from(JSON.stringify({ not: 'an array' }), 'utf8')));
    return settle(async () => {
      const list = await svc.listRetentionGroups();
      return Array.isArray(list) && list.length === 0;
    });
  });

  // Cleanup: leave the throwaway key tombstoned-ish (empty array). Harmless
  // either way — the driver only ever reads the PRODUCTION key, never this one.
  await check('cleanup: reset throwaway key to []', async () => {
    await svc.deregisterRetentionGroup({ group_id: g2 }); // no-op if already gone
    const list = await svc.listRetentionGroups();
    return Array.isArray(list);
  });
} else {
  console.log('ONLINE: skipped.');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
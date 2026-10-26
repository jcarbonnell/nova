// shade-agent/test/test-signer-lock.mjs
//
// S2.0 — per-signer lock in lib/kv.ts. Proves:
//   OFFLINE (no network): withSignerLock never runs two sections for the same key
//     at once, runs them FIFO, a rejection does not block the next, different keys
//     do not block each other, and idle entries are dropped.
//   ONLINE (real seed + KV): THREE concurrent storeBlobToKV calls (same signer,
//     nova-sdk.near) all commit and read back — no InvalidNonce.
//
// MUTATION: in withSignerLock replace the body with
//     void signerLocks; return fn();
//   → OFFLINE "max concurrency 1" + "FIFO" fail, ONLINE "3 concurrent writes"
//     fails with InvalidNonce (same signature as the S1.6 M2 run).
//
// Build first:  npm run build
// Run:          node --env-file=.env ./test/test-signer-lock.mjs
// Signs as nova-sdk.near; three sub-cent KV writes under throwaway keys.

import crypto from 'node:crypto';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nSigner-lock harness (S2.0)\n');

const kv = await import('../dist/lib/kv.js');

// ── OFFLINE ──
console.log('OFFLINE (lock semantics):');

await check('same key: max concurrency 1 and FIFO order', async () => {
  let active = 0, maxActive = 0;
  const order = [];
  const job = (i, ms) => kv.withSignerLock('k-same', async () => {
    active++; maxActive = Math.max(maxActive, active);
    await sleep(ms);
    order.push(i);
    active--;
    return i;
  });
  // Longer jobs first: without the lock they would finish out of order.
  const res = await Promise.all([job(1, 120), job(2, 60), job(3, 10)]);
  return maxActive === 1
      && JSON.stringify(order) === '[1,2,3]'
      && JSON.stringify(res) === '[1,2,3]';
});

await check('a rejected section does not block the next (and the error still reaches its caller)', async () => {
  const p1 = kv.withSignerLock('k-err', async () => { await sleep(20); throw new Error('boom'); });
  const p2 = kv.withSignerLock('k-err', async () => 'ok');
  let p1Rejected = false;
  try { await p1; } catch (e) { p1Rejected = e.message === 'boom'; }
  return p1Rejected && (await p2) === 'ok';
});

await check('different keys do not block each other', async () => {
  const t0 = Date.now();
  await Promise.all([
    kv.withSignerLock('k-a', () => sleep(150)),
    kv.withSignerLock('k-b', () => sleep(150)),
  ]);
  return Date.now() - t0 < 280; // serialized would be >= 300ms
});

await check('idle entries are dropped (no growth with one-off signers)', async () => {
  await sleep(10); // let the tail cleanups from the checks above run
  return kv._signerLockCount() === 0;
});

// ── ONLINE ──
let haveSeed = false;
try {
  const { initializeMasterSeed } = await import('../dist/lib/seed.js');
  await initializeMasterSeed();
  haveSeed = true;
  console.log('\nseed: real master seed loaded (ONLINE enabled)\n');
} catch (e) {
  console.log(`\nseed: none — ONLINE skipped: ${e?.message || e}\n`);
}

if (haveSeed) {
  console.log('ONLINE (real signer, real KV, throwaway keys):');
  const { encryptBlob, decryptBlob } = await import('../dist/lib/crypto.js');
  const run = crypto.randomUUID();
  const keys = [0, 1, 2].map((i) => `_signer_lock_TEST_${run}_${i}`);
  const payload = (i) => encryptBlob(Buffer.from(JSON.stringify({ run, i }), 'utf8'));

  await check('3 concurrent storeBlobToKV (same signer) all commit — no InvalidNonce', async () => {
    const results = await Promise.allSettled(keys.map((k, i) => kv.storeBlobToKV(k, payload(i))));
    const rejected = results.filter((r) => r.status === 'rejected');
    rejected.forEach((r) => console.log(`      rejected: ${r.reason?.message || r.reason}`));
    return rejected.length === 0;
  });

  await check('all 3 blobs read back with the right content', async () => {
    return settle(async () => {
      for (let i = 0; i < 3; i++) {
        const blob = await kv.getBlobFromKVStrict(keys[i]);
        if (!blob) return false;
        const v = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
        if (v.run !== run || v.i !== i) return false;
      }
      return true;
    });
  });

  await check('signer lock map is empty after the writes', async () => {
    await sleep(10);
    return kv._signerLockCount() === 0;
  });
} else {
  console.log('ONLINE: skipped.');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
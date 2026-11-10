// shade-agent/src/lib/seed.ts
//
// §5.12 (2026-11 incident rebuild): the master seed comes from the TEE
// (lib/tee-keys.ts, path nova/master-seed/v1), loaded once at boot.
//
// Retired with it: the `master-root` KV blob, the seed derived from
// SPONSOR_PRIVATE_KEY, and MASTER_SEED_INIT_ALLOWED. No KV read happens here.
//
// initializeMasterSeed() keeps its name and signature so its two callers
// (rpc/base.ts middleware, scheduler-live init) are unchanged. It now only
// confirms the TEE keys were loaded, and fails closed otherwise.
//
// Harness: test/test-crypto-tee.mjs (C9).

import { getMasterSeedSync } from './crypto.js';

/** Returns the TEE master seed; throws TeeKeysError until loadTeeKeys() has run. */
export async function initializeMasterSeed(): Promise<Uint8Array> {
  return getMasterSeedSync();
}
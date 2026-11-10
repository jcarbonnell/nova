// shade-agent/src/lib/seed.ts
//
// Master seed loading — the ONE place the seed is read from KV.
//
// §5.12 (2026-11 incident rebuild), on the portable design (roadmap §5.12):
// the master seed is RANDOM, generated OFFLINE by the operator, encrypted under
// TEE_KEY_SECRET (AES-256-GCM) and written to KV as `master-root` by the operator
// himself, signed with nova-sdk.near's own key. This is the procedure used for the
// original production seed (March 2026); Shade's former init branch (seed derived
// from SPONSOR_PRIVATE_KEY, behind MASTER_SEED_INIT_ALLOWED) never produced it and
// is removed. Because the operator holds the seed before the first boot, he also
// computes Shade's signer public keys from it and adds them in advance.
//
// LOAD-ONLY, by design:
//   • the read is STRICT: an RPC failure throws, it never reads as "no seed";
//   • there is no write path: Shade cannot create or overwrite `master-root`;
//   • concurrent first calls share one KV read.
// This module is separate from crypto.ts to keep the dependency graph acyclic:
// crypto.ts holds the seed state and does no I/O; this module does the I/O.
//
// Harness: test/test-seed.mjs.
import { hasMasterSeed, setMasterSeed, getMasterSeedSync, decryptBlob } from './crypto.js';
import { getBlobFromKVStrict, KV_CONTRACT } from './kv.js';
export const MASTER_ROOT_KEY = 'master-root';
let inFlight = null;
/**
 * Load the master seed from KV once; afterwards return it from memory.
 * Safe to call on every request (rpc/base.ts middleware does).
 */
export async function initializeMasterSeed() {
    if (hasMasterSeed())
        return getMasterSeedSync();
    if (!inFlight) {
        inFlight = loadMasterSeed().finally(() => { inFlight = null; });
    }
    return inFlight;
}
async function loadMasterSeed() {
    const blob = await getBlobFromKVStrict(MASTER_ROOT_KEY); // throws on RPC failure
    if (!blob) {
        throw new Error(`${MASTER_ROOT_KEY} not found in ${KV_CONTRACT}. Shade never creates the master seed: ` +
            'the operator writes it once (offline seed procedure, roadmap §5.12).');
    }
    const seed = decryptBlob(blob); // GCM only; refuses legacy CBC and wrong keys
    if (seed.length !== 32) {
        throw new Error(`${MASTER_ROOT_KEY} holds ${seed.length} bytes; expected 32`);
    }
    setMasterSeed(seed);
    console.log('✅ Master seed loaded from KV');
    return seed;
}

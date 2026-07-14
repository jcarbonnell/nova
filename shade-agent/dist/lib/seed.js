// shade-agent/src/lib/seed.ts
//
// Master seed initialization — the ONE place the seed is loaded from KV.
//
// Unifies two previously separate implementations:
//   routes/user-keys.ts       → initializeMasterSeedIfNeeded(): Promise<void>
//   routes/key-management.ts  → getMasterSeed(): Promise<Uint8Array>
// Same load-first logic (both correct since v0.3.2 Fix 7), but each held its own
// `let masterSeed` and did its own KV read. Now: one seed, one load, one code path.
//
// This module exists separately from crypto.ts to keep the dependency graph
// acyclic: kv.ts needs deriveKey (crypto.ts) to derive its signer keypair, and
// seed loading needs kv.ts. crypto.ts holds the state but does no I/O; seed.ts
// does the I/O and hands the result to crypto.ts via setMasterSeed().
import crypto from 'crypto';
import { hasMasterSeed, setMasterSeed, getMasterSeedSync, encryptBlob, decryptBlob } from './crypto.js';
import { getBlobFromKV, storeBlobToKV } from './kv.js';
/**
 * Load the master seed from KV, initializing it ONLY if KV is empty.
 * Idempotent: safe to call on every request (routers do, via middleware).
 *
 * SECURITY (v0.3.2 Fix 7): ALWAYS load from KV first. The master seed is the
 * root of all derived keys — overwriting an existing seed makes every account,
 * group key, file key and API key permanently underivable.
 * MASTER_SEED_INIT_ALLOWED can ONLY cause a *first* initialization when KV is
 * empty; it can NEVER overwrite an existing seed, even if left set to 'true'
 * across a redeploy.
 */
export async function initializeMasterSeed() {
    if (hasMasterSeed())
        return getMasterSeedSync();
    const encryptedBlob = await getBlobFromKV('master-root');
    if (encryptedBlob) {
        const seed = decryptBlob(encryptedBlob);
        setMasterSeed(seed);
        console.log('✅ Master seed loaded from KV');
        return seed;
    }
    // KV is empty — first-time init only, and only if explicitly allowed.
    const MASTER_SEED_INIT_ALLOWED = process.env.MASTER_SEED_INIT_ALLOWED === 'true';
    if (!MASTER_SEED_INIT_ALLOWED) {
        throw new Error('Master seed not found in KV and MASTER_SEED_INIT_ALLOWED is not set. ' +
            'Set MASTER_SEED_INIT_ALLOWED=true on first deploy only, then remove it.');
    }
    console.warn('⚠️  Initializing NEW master seed — this must run ONLY once, ever.');
    const sponsorKey = process.env.SPONSOR_PRIVATE_KEY;
    const sponsorKeyBytes = Buffer.from(sponsorKey.replace('ed25519:', ''), 'base64');
    const newSeed = new Uint8Array(crypto.createHash('sha256')
        .update(Buffer.concat([
        sponsorKeyBytes,
        Buffer.from('nova-master-seed-v1', 'utf8'),
    ]))
        .digest());
    // Set before storing so that storeBlobToKV — which derives its own signer key
    // from the master seed — can actually sign the transaction that stores it.
    setMasterSeed(newSeed);
    const encrypted = encryptBlob(newSeed);
    await storeBlobToKV('master-root', encrypted);
    console.log('✅ Master seed initialized and stored on-chain');
    return newSeed;
}

// shade-agent/src/lib/legacy.ts
//
// §5.12 L1–L2: read-only access to the PRE-SWITCH KV, inside Shade on the new CVM.
//
// Before 2026-11-12 every record lived in `nova-kv.near`, encrypted under the old
// TEE_KEY_SECRET (leaked 2026-11-08), and every key derived from the old master
// seed. Since the switch, records live in KV_CONTRACT (`nova-kv-2.near`) under the
// new secret and seed. This module lets Shade READ the old records and derive the
// old group keys, so pre-switch files stay retrievable for their authorized members.
//
// RULES (each one asserted by test/test-legacy.mjs):
//   • The era of a record is the contract it is found in. readRecord() looks in
//     KV_CONTRACT first; only a key ABSENT there is looked up in nova-kv.near.
//     The current KV always wins (a post-switch tombstone shadows a legacy key).
//   • Both reads are STRICT: an RPC failure is a 503, never "absent" (an outage
//     must not let a legacy record shadow a newer one, e.g. a tombstone).
//   • The legacy seed only ever UNWRAPS pre-switch records. Nothing new is ever
//     wrapped or derived under it (key-management.ts: generateFileKey and
//     rotateTo use deriveKey, the new seed, only).
//   • The legacy seed loads once, from nova-kv.near's `master-root`, and only if
//     three pins hold: the ciphertext's sha256, the secret's fingerprint, and the
//     old KV signer public key it must derive (`kv-owner-signer-v1` → GhFN…, the
//     key that signed the old Shade's KV writes). A wrong secret or a replaced
//     blob is refused by name; no key is ever served from an unverified seed.
//   • LEGACY_TEE_KEY_SECRET absent → pre-switch records answer 503
//     LEGACY_UNAVAILABLE; everything post-switch keeps working.
//
// L4 (decided 2026-11-13, a divergence from the roadmap's "stores the legacy
// seed"): the OLD SECRET is copied once into KV_CONTRACT as `legacy-tee-key`,
// encrypted under the NEW secret, after it has passed every pin. Pre-switch
// records are encrypted under the old secret, so the seed alone could not open
// them. Once the copy is stored (`/` → legacy.key_copy_stored), the env variable
// LEGACY_TEE_KEY_SECRET is removed by an env update; Shade then reads the copy.
// The copy is never rewritten, and a copy that fails the fingerprint pin is
// refused (no fallback to the env). Ending legacy access later = tombstoning it.
//
// Restores access, not privacy: whoever holds the leaked secret can read every
// pre-switch record. L3 re-keys the demo accounts.
import crypto from 'crypto';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';
import { decryptBlob, encryptBlob, deriveKeyWith, GCM_MAGIC } from './crypto.js';
import { getBlobFromKVStrict, storeBlobToKV, KV_CONTRACT } from './kv.js';
import { ApiError } from './errors.js';
import { log } from './logger.js';
export const LEGACY_KV_CONTRACT = 'nova-kv.near';
export const LEGACY_MASTER_ROOT_KEY = 'master-root';
/** L4: the old secret's copy, in KV_CONTRACT, under the new secret. Write-once. */
export const LEGACY_KEY_COPY = 'legacy-tee-key';
export const LEGACY_PINS = Object.freeze({
    masterRootSha256: '3fcc45faf36fe08213cf8eca5c2b6d6cc9235cd761cc673b45184c0883cd837f',
    secretFingerprint: 'a9a39248a959',
    signerPublicKey: 'ed25519:GhFNnrrZ4roarJDPmP1VPR3KwcmCcBERkb5mdSt5kJ6R',
});
export const LEGACY_SIGNER_SALT = 'kv-owner-signer-v1';
let pins = LEGACY_PINS;
let legacySeed = null;
let inFlight = null;
let cachedKey = null; // the verified old secret, once read
let keySource = null;
let keyCopyStored = false;
/** Exposed for test/test-legacy.mjs only (its secrets and seeds are random). */
export function _setLegacyPinsForTest(p) {
    pins = p ? Object.freeze({ ...p }) : LEGACY_PINS;
    legacySeed = null;
    inFlight = null;
    cachedKey = null;
    keySource = null;
    keyCopyStored = false;
}
const unavailable = (why) => new ApiError(503, 'LEGACY_UNAVAILABLE', `Pre-switch record unavailable: ${why}`);
// ────────────────────────────────────────────────
// The old secret
// ────────────────────────────────────────────────
const fingerprintOf = (secret) => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
/**
 * The old secret: from the L4 copy in KV_CONTRACT if one exists, otherwise from
 * LEGACY_TEE_KEY_SECRET. Either source must match the pinned fingerprint; a copy
 * that does not is refused WITHOUT falling back to the env (it means tampering or
 * a bug, never a reason to try another key).
 */
async function legacyKey() {
    if (cachedKey)
        return cachedKey;
    const copy = await strictRead(LEGACY_KEY_COPY, KV_CONTRACT);
    if (copy) {
        let secret;
        try {
            secret = Buffer.from(decryptBlob(copy)).toString('utf8');
        }
        catch {
            throw unavailable(`the stored ${LEGACY_KEY_COPY} did not decrypt under the current secret`);
        }
        if (!/^[0-9a-f]{64}$/i.test(secret) || fingerprintOf(secret) !== pins.secretFingerprint) {
            throw unavailable(`the stored ${LEGACY_KEY_COPY} does not match its pinned fingerprint`);
        }
        cachedKey = Buffer.from(secret, 'hex');
        keySource = 'kv';
        keyCopyStored = true;
        return cachedKey;
    }
    const secret = process.env.LEGACY_TEE_KEY_SECRET;
    if (!secret)
        throw unavailable('LEGACY_TEE_KEY_SECRET is not set');
    if (!/^[0-9a-f]{64}$/i.test(secret))
        throw unavailable('LEGACY_TEE_KEY_SECRET is not 64 hex characters');
    if (fingerprintOf(secret) !== pins.secretFingerprint) {
        throw unavailable('LEGACY_TEE_KEY_SECRET does not match its pinned fingerprint');
    }
    cachedKey = Buffer.from(secret, 'hex');
    keySource = 'env';
    return cachedKey;
}
/**
 * L4: once the secret from the env has opened the pinned master-root and derived
 * the pinned signer, copy it into KV_CONTRACT under the new secret. Write-once
 * (re-checked strictly just before writing). Non-fatal: a failed write leaves the
 * env as the source and is retried at the next load.
 */
async function storeKeyCopyOnce(key) {
    if (keySource !== 'env' || keyCopyStored)
        return;
    try {
        if (await strictRead(LEGACY_KEY_COPY, KV_CONTRACT)) {
            keyCopyStored = true;
            return;
        }
        await storeBlobToKV(LEGACY_KEY_COPY, encryptBlob(Buffer.from(key.toString('hex'), 'utf8')));
        keyCopyStored = true;
        log('info', 'legacy_key_copy_stored', { contract: KV_CONTRACT });
    }
    catch (e) {
        log('warn', 'legacy_key_copy_failed', { message: e instanceof Error ? e.message : String(e) });
    }
}
/**
 * The pre-switch decryptBlob, VERBATIM from commit 3ca43d8 (the image the old CVM
 * ran, unchanged through shade v61), with the key passed in. GCM ("NOVG") blobs,
 * CBC "iv:ct" strings and raw CBC [16 IV][ct] bytes. Never called with the
 * current secret, and never used to write.
 */
export function legacyDecryptBlob(enc, key) {
    let raw;
    if (Array.isArray(enc)) {
        raw = Buffer.from(enc);
    }
    else if (enc.includes(':')) {
        const [ivStr, encStr] = enc.split(':');
        if (!ivStr || !encStr)
            throw new Error('Invalid encrypted blob format');
        const iv = Buffer.from(ivStr, 'hex');
        const encrypted = Buffer.from(encStr, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    }
    else {
        raw = Buffer.from(enc, 'hex');
    }
    if (raw.length >= 32 && raw.subarray(0, 4).equals(GCM_MAGIC)) {
        const iv = raw.subarray(4, 16);
        const tag = raw.subarray(16, 32);
        const ciphertext = raw.subarray(32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    }
    if (raw.length < 17)
        throw new Error('Encrypted blob too short');
    const iv = raw.subarray(0, 16);
    const encrypted = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
}
async function strictRead(keyId, contract) {
    try {
        return await getBlobFromKVStrict(keyId, contract);
    }
    catch {
        throw new ApiError(503, 'KV_UNAVAILABLE', `KV read failed (${contract}); retry`);
    }
}
/**
 * One KV record: from KV_CONTRACT if present there (era 'current'), otherwise
 * from nova-kv.near under the old secret (era 'legacy'), otherwise null.
 */
export async function readRecord(keyId) {
    if (!KV_CONTRACT || KV_CONTRACT === LEGACY_KV_CONTRACT) {
        throw new ApiError(500, 'KV_MISCONFIGURED', `KV_CONTRACT_ID must be set, and not the pre-switch ${LEGACY_KV_CONTRACT}`);
    }
    const current = await strictRead(keyId, KV_CONTRACT);
    if (current)
        return { bytes: decryptBlob(current), era: 'current' };
    const old = await strictRead(keyId, LEGACY_KV_CONTRACT);
    if (!old)
        return null;
    const key = await legacyKey();
    try {
        return { bytes: legacyDecryptBlob(old, key), era: 'legacy' };
    }
    catch {
        throw unavailable('a pre-switch record did not decrypt under the legacy secret');
    }
}
// ────────────────────────────────────────────────
// The old seed
// ────────────────────────────────────────────────
async function loadLegacySeed() {
    const key = await legacyKey();
    const blob = await strictRead(LEGACY_MASTER_ROOT_KEY, LEGACY_KV_CONTRACT);
    if (!blob)
        throw unavailable(`${LEGACY_MASTER_ROOT_KEY} not found in ${LEGACY_KV_CONTRACT}`);
    const raw = Array.isArray(blob) ? Buffer.from(blob) : Buffer.from(blob, 'hex');
    if (crypto.createHash('sha256').update(raw).digest('hex') !== pins.masterRootSha256) {
        throw unavailable(`${LEGACY_MASTER_ROOT_KEY} in ${LEGACY_KV_CONTRACT} does not match its pinned hash`);
    }
    let seed;
    try {
        seed = legacyDecryptBlob(blob, key);
    }
    catch {
        throw unavailable(`${LEGACY_MASTER_ROOT_KEY} did not decrypt under the legacy secret`);
    }
    if (seed.length !== 32)
        throw unavailable(`legacy seed holds ${seed.length} bytes; expected 32`);
    const signerPub = await ed25519.getPublicKeyAsync(deriveKeyWith(seed, LEGACY_SIGNER_SALT, 32));
    const signer = `ed25519:${bs58.encode(signerPub)}`;
    if (signer !== pins.signerPublicKey) {
        throw unavailable('legacy seed does not derive the pinned old signer key');
    }
    legacySeed = seed;
    log('info', 'legacy_seed_loaded', { signer, key_source: keySource }); // public key only
    await storeKeyCopyOnce(key); // L4: only after every pin has held
    return seed;
}
/** HKDF under the OLD seed (loaded and pin-checked on first use). Unwrap only. */
export async function legacyDeriveKey(salt, length = 32) {
    if (!legacySeed) {
        if (!inFlight)
            inFlight = loadLegacySeed().finally(() => { inFlight = null; });
        await inFlight;
    }
    return deriveKeyWith(legacySeed, salt, length);
}
/**
 * L4, at boot (after the master seed): load the legacy seed if a source exists,
 * which stores the key copy when the source is the env. Never throws; a missing
 * source is the normal state once legacy access has ended.
 */
export async function initializeLegacy() {
    try {
        await legacyDeriveKey(LEGACY_SIGNER_SALT, 32);
    }
    catch (e) {
        log('warn', 'legacy_init_skipped', { message: e instanceof Error ? e.message : String(e) });
    }
}
/** For `/`: whether pre-switch records can be read, and whether the env can go. */
export function getLegacyStatus() {
    return { seed_loaded: legacySeed !== null, key_source: keySource, key_copy_stored: keyCopyStored };
}

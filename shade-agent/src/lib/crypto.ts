// shade-agent/src/lib/crypto.ts
//
// THE single source of truth for NOVA's blob crypto and key derivation.
//
// Previously duplicated byte-for-byte across routes/user-keys.ts and
// routes/key-management.ts. If those copies had ever drifted, blobs written by
// one route would have become unreadable by the other — including `master-root`
// itself, which would make every derived key (account, group, file, API,
// KV-signer) permanently underivable. That hazard is why this module exists.
//
// This module holds the master seed STATE but performs NO I/O. Loading the seed
// from KV lives in lib/seed.ts, which imports from here and from lib/kv.ts.
// That split is what keeps the dependency graph acyclic (kv.ts needs deriveKey
// to derive its own signer keypair).
//
// §5.12 (2026-11 incident rebuild): the two root secrets now come from the TEE
// (lib/tee-keys.ts), never from the environment:
//   • blob encryption key  = getTeeKeys().kvEncryptionKey  (was TEE_KEY_SECRET)
//   • master seed          = getTeeKeys().masterSeed       (was derived from
//                            SPONSOR_PRIVATE_KEY and stored as the master-root blob)
// The KV store is fresh (new KV contract), so the legacy CBC read path is gone:
// decryptBlob accepts AES-256-GCM blobs only and refuses anything else.
// deriveKey's HKDF parameters are unchanged; any change to them, or to the GCM
// layout, is a breaking change against KV data. Do not "clean up" here.
//
// Harness: test/test-crypto-tee.mjs.

import crypto, { hkdfSync } from 'crypto';
import { getTeeKeys, TeeKeysError } from './tee-keys.js';

// ────────────────────────────────────────────────
// Master seed (from the TEE)
// ────────────────────────────────────────────────
//
// The seed is no longer state held here: it is the TEE-derived key loaded once
// at boot by loadTeeKeys(). These three functions keep their signatures so that
// seed.ts and its callers compile unchanged until they are simplified.

/** True once the TEE keys are loaded (loadTeeKeys() at boot). */
export function hasMasterSeed(): boolean {
  try {
    getTeeKeys();
    return true;
  } catch {
    return false;
  }
}

/** Throws until the TEE keys are loaded. */
export function getMasterSeedSync(): Uint8Array {
  return getTeeKeys().masterSeed;
}

/** Retired: the master seed comes from the TEE and cannot be set. */
export function setMasterSeed(_seed: Uint8Array): void {
  throw new TeeKeysError('setMasterSeed is retired: the master seed comes from the TEE (loadTeeKeys)');
}

// ────────────────────────────────────────────────
// Deterministic derivation
// ────────────────────────────────────────────────
//
// Salts in use — changing ANY of these silently orphans data:
//   'fastfs-path-salt'                            → FastFS path salt (lib/fastfs.ts)
//   `api-key:{account_id}`                        → deterministic API keys
//   `group:{group_id}:{network}:{contract}[:v{n}]` → group encryption keys

export function deriveKey(salt: string, length: number = 32): Uint8Array {
  const master = getMasterSeedSync();
  const derived = hkdfSync(
    'sha256',
    master,
    Buffer.from(salt),
    Buffer.from('nova-v1'),
    length,
  );
  return new Uint8Array(derived);
}

// ────────────────────────────────────────────────
// Blob encryption (AES-256-GCM only)
// ────────────────────────────────────────────────
//
// Stored-byte layout: [4-byte magic "NOVG"][12-byte IV][16-byte tag][ciphertext],
// returned as one hex string. Key: getTeeKeys().kvEncryptionKey (32 bytes).

export const GCM_MAGIC = Buffer.from([0x4e, 0x4f, 0x56, 0x47]); // "NOVG"

function blobKey(): Buffer {
  return Buffer.from(getTeeKeys().kvEncryptionKey); // throws until loadTeeKeys()
}

export function encryptBlob(data: Uint8Array): string {
  const key = blobKey();
  const iv = crypto.randomBytes(12); // GCM standard IV length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return Buffer.concat([GCM_MAGIC, iv, tag, encrypted]).toString('hex');
}

export function decryptBlob(enc: string | number[]): Uint8Array {
  const key = blobKey();

  if (typeof enc === 'string' && enc.includes(':')) {
    throw new Error('Legacy CBC blob refused: only AES-256-GCM blobs are readable');
  }
  const raw = Array.isArray(enc) ? Buffer.from(enc) : Buffer.from(enc, 'hex');

  // Magic + 12-byte IV + 16-byte tag = 32 bytes of framing.
  if (raw.length < 32 || !raw.subarray(0, 4).equals(GCM_MAGIC)) {
    throw new Error('Not an AES-256-GCM blob (missing NOVG header); legacy CBC blobs are refused');
  }
  const iv = raw.subarray(4, 16);
  const tag = raw.subarray(16, 32);
  const ciphertext = raw.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

// Parameterized AES-256-GCM for KEY WRAPPING 
// encryptBlob/decryptBlob above wrap under the TEE KV key (KV blobs at rest);
// gcmWrap/gcmUnwrap wrap under an ARBITRARY 32-byte key — used to wrap a random
// per-file key under a group key v{N}. Layout: [12 IV][16 tag][ciphertext] hex.
export function gcmWrap(data: Uint8Array, key: Uint8Array): string {
  if (key.length !== 32) throw new Error('gcmWrap: key must be 32 bytes');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('hex');
}
 
export function gcmUnwrap(enc: string, key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error('gcmUnwrap: key must be 32 bytes');
  const raw = Buffer.from(enc, 'hex');
  if (raw.length < 28) throw new Error('gcmUnwrap: blob too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

// ────────────────────────────────────────────────
// Small hashing helpers (were inlined at every call site)
// ────────────────────────────────────────────────

/** sha256 hex — used for KV key IDs (`user:{sub}`, `account:{id}`, `api-hash:{id}`, …). */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Short hash for PII-safe logging (12 hex chars). */
export function hashForLog(input: string): string {
  return sha256Hex(input).slice(0, 12);
}

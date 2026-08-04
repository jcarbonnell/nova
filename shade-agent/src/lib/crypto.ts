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
// EVERY function below is lifted verbatim from the pre-extraction routes.
// Any change to deriveKey's HKDF parameters or decryptBlob's format dispatch is
// a breaking change against live production KV data. Do not "clean up" here.

import crypto, { hkdfSync } from 'crypto';

// ────────────────────────────────────────────────
// Master seed state (single shared instance)
// ────────────────────────────────────────────────
//
// v0.4 CHANGE: previously each route module held its OWN `let masterSeed` and
// performed its own lazy KV load — two in-memory copies, two init code paths,
// two KV reads per cold start. They held the same value, but nothing enforced
// that. Now there is exactly one.

let masterSeed: Uint8Array | null = null;

export function setMasterSeed(seed: Uint8Array): void {
  masterSeed = seed;
}

export function hasMasterSeed(): boolean {
  return masterSeed !== null;
}

/** Throws if the seed has not been loaded. Callers must run initializeMasterSeed() first. */
export function getMasterSeedSync(): Uint8Array {
  if (!masterSeed) throw new Error('Master seed not initialized');
  return masterSeed;
}

// ────────────────────────────────────────────────
// Deterministic derivation
// ────────────────────────────────────────────────
//
// Live salts in production — changing ANY of these silently orphans data:
//   'kv-owner-signer-v1'                          → KV store signer (nova-sdk.near)
//   'nova-signer-v1'                              → contract-call signer (kv-signer.nova-kv.near)
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
// Blob encryption (AES-256-GCM, with legacy CBC read path)
// ────────────────────────────────────────────────
//
// GCM stored-byte layout: [4-byte magic "NOVG"][12-byte IV][16-byte tag][ciphertext]
// New blobs are written with AES-256-GCM. Legacy CBC blobs remain readable via
// decryptBlob's fallback (shipped v0.3.2 Fix 8; the production master-root is
// still a CBC blob and MUST keep decrypting).

export const GCM_MAGIC = Buffer.from([0x4e, 0x4f, 0x56, 0x47]); // "NOVG"

export function encryptBlob(data: Uint8Array): string {
  const TEE_SECRET = process.env.TEE_KEY_SECRET!;
  if (!TEE_SECRET || !/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
    throw new Error('TEE_KEY_SECRET must be a 64-char hex string');
  }
  const iv = crypto.randomBytes(12); // GCM standard IV length
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(TEE_SECRET, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes
  // Return the COMPLETE stored layout as a single hex string (no colons).
  return Buffer.concat([GCM_MAGIC, iv, tag, encrypted]).toString('hex');
}

export function decryptBlob(enc: string | number[]): Uint8Array {
  const TEE_SECRET = process.env.TEE_KEY_SECRET!;
  if (!TEE_SECRET || !/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
    throw new Error('TEE_KEY_SECRET must be a 64-char hex string');
  }
  const key = Buffer.from(TEE_SECRET, 'hex');

  // Normalize input to the raw stored bytes.
  let raw: Buffer;
  if (Array.isArray(enc)) {
    raw = Buffer.from(enc);
  } else if (enc.includes(':')) {
    // Legacy CBC string form "ivhex:encryptedhex"
    const [ivStr, encStr] = enc.split(':');
    if (!ivStr || !encStr) throw new Error('Invalid encrypted blob format');
    const iv = Buffer.from(ivStr, 'hex');
    const encrypted = Buffer.from(encStr, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
  } else {
    raw = Buffer.from(enc, 'hex'); // new complete-layout hex
  }

  // GCM? magic present and enough bytes for framing (4 magic + 12 iv + 16 tag).
  if (raw.length >= 32 && raw.subarray(0, 4).equals(GCM_MAGIC)) {
    const iv = raw.subarray(4, 16);   // 12 bytes
    const tag = raw.subarray(16, 32); // 16 bytes
    const ciphertext = raw.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  }

  // Legacy CBC raw bytes: [16-byte IV][ciphertext].
  if (raw.length < 17) throw new Error('Encrypted blob too short');
  const iv = raw.subarray(0, 16);
  const encrypted = raw.subarray(16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return new Uint8Array(Buffer.concat([decipher.update(encrypted), decipher.final()]));
}

// Parameterized AES-256-GCM for KEY WRAPPING 
// encryptBlob/decryptBlob above wrap under TEE_KEY_SECRET (KV blobs at rest);
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

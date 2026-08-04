// shade-agent/src/lib/fastfs.ts
//
// FastFS storage module (roadmap §5.2, §5.4). Replaces IPFS as the write path;
// legacy IPFS RETRIEVAL is preserved indefinitely, no new IPFS uploads.
//
// FastFS is NOT a contract. A `__fastdata_fastfs` call is a data-envelope: the
// on-chain call is a no-op that fails with CodeDoesNotExist BY DESIGN, and an
// off-chain FastNear indexer reads the action args from finalized block history.
//   • SUCCESS = NEAR finalized the tx. We never read the no-op execution result
//     as a success signal — we ASSERT it is exactly CodeDoesNotExist (tripwire).
//   • DURABILITY = the NEAR chain (bytes live in archival history). The fastfs.io
//     gateway is a SWAPPABLE reader; self-hosting fastdata-indexer is the fallback.
//     So the stored location is reader-independent — never a hard-coded URL.
//   • DELETION = gateway stops serving; bytes persist in history + FastData KV
//     history. Real erasure is crypto-shred (destroy the file key, §5.1/§6.2);
//     the null-content write here is cosmetic serving-layer cleanup.

import crypto from 'crypto';
import { deriveKey } from './crypto.js';
import { ApiError } from './errors.js';
import { signAndBroadcastFunctionCall, borshString, borshBytes } from './kv.js';

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────
// Predecessor = the NOVA account that signs the envelope (Arch 2: the existing
// KV-owner signer, nova-sdk.near — spike-validated). Receiver = the namespace
// label in the gateway path; needs no contract. Gateway is the DEFAULT reader.
const FASTFS_RECEIVER    = process.env.FASTFS_RECEIVER    || 'fastfs.near';
const FASTFS_PREDECESSOR = process.env.FASTFS_PREDECESSOR || 'nova-sdk.near';
const FASTFS_GATEWAY_TPL = process.env.FASTFS_GATEWAY_TPL || 'https://{pred}.fastfs.io';
const FASTFS_MIME        = 'application/octet-stream'; // opaque ciphertext

export type StorageBackend = 'fastfs' | 'ipfs';
export interface StorageLocation { backend: StorageBackend; location: string; }

// ────────────────────────────────────────────────
// §5.4 path scheme — seed-derived, per-group, enumeration-resistant
// ────────────────────────────────────────────────
// prefix = sha256( group_id || HKDF(master_seed, "fastfs-path-salt") )
// Per GROUP, NOT per key-version: a file's location is stable across rotations
// (rotation changes decryptability, not where the bytes live). Only Shade can
// compute this (master seed), which keeps group paths unguessable.
//
// ⚠️ 'fastfs-path-salt' is a NEW live derivation salt. It is ADDITIVE — it does
// not alter any existing salt — but it must be added to crypto.ts's salt
// inventory comment and pinned in the derivation harness (the lib-extraction
// harness pins 5 salts; this is the 6th).
export function deriveFastfsPathPrefix(groupId: string): string {
  const salt = deriveKey('fastfs-path-salt', 32); // requires master seed (Shade only)
  return crypto.createHash('sha256')
    .update(groupId, 'utf8')
    .update(Buffer.from(salt))
    .digest('hex');
}

export function newRelativePath(groupId: string): string {
  return `${deriveFastfsPathPrefix(groupId)}/${crypto.randomUUID()}`;
}

// ────────────────────────────────────────────────
// Reader-independent location scheme (sovereignty: no hard-coded gateway)
// ────────────────────────────────────────────────
// Stored form: "{predecessor}/{receiver}/{relative_path}". Enough to reconstruct
// retrieval from the fastfs.io gateway, a self-hosted indexer, or a NEAR
// archival lookup. Step 4's contract stores this as FileTransaction.location
// with backend=FastFS.
export function encodeFastfsLocation(
  rel: string,
  predecessor: string = FASTFS_PREDECESSOR,
  receiver: string = FASTFS_RECEIVER,
): string {
  return `${predecessor}/${receiver}/${rel}`;
}

export function parseFastfsLocation(location: string): {
  predecessor: string; receiver: string; relativePath: string;
} {
  const i = location.indexOf('/');
  const j = location.indexOf('/', i + 1);
  if (i < 0 || j < 0) throw new ApiError(400, 'BAD_LOCATION', 'Malformed FastFS location');
  return {
    predecessor: location.slice(0, i),
    receiver: location.slice(i + 1, j),
    relativePath: location.slice(j + 1),
  };
}

// ────────────────────────────────────────────────
// Retrieve — default reader is the fastfs.io gateway; pluggable
// ────────────────────────────────────────────────
export async function retrieve(loc: StorageLocation): Promise<Uint8Array> {
  if (loc.backend === 'ipfs') return retrieveIpfsLegacy(loc.location);

  const { predecessor, receiver, relativePath } = parseFastfsLocation(loc.location);
  const base = FASTFS_GATEWAY_TPL.replace('{pred}', predecessor);
  const url = `${base}/${receiver}/${relativePath}`;

  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new ApiError(res.status === 404 ? 404 : 500, 'FASTFS_READ_FAILED',
      `FastFS read failed: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Legacy IPFS retrieval — preserved indefinitely. There is NO IPFS upload path.
async function retrieveIpfsLegacy(cid: string): Promise<Uint8Array> {
  const gw = process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud/ipfs';
  const res = await fetch(`${gw}/${cid.replace(/^\/+/, '')}`, { cache: 'no-store' });
  if (!res.ok) throw new ApiError(500, 'IPFS_READ_FAILED', `IPFS read failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ────────────────────────────────────────────────
// Finalization-as-success + CodeDoesNotExist tripwire
// ────────────────────────────────────────────────
// Called with the FinalExecutionOutcome from a provider-level broadcast. Reaching
// here means the tx FINALIZED (broadcast returned an outcome) — that is success.
// The envelope is expected to carry a no-op execution FAILURE of exactly
// CodeDoesNotExist at the FastFS receiver. Any OTHER status is an anomaly:
// a contract deployed at the receiver, a malformed action, wrong receiver.
export function assertFastfsEnvelopeFinalized(outcome: any, receiver: string = FASTFS_RECEIVER): void {
  // Proof of finalization: broadcast_tx_commit returns a tx hash only for an
  // included, finalized transaction. No hash ⇒ we cannot claim the bytes landed.
  if (!outcome?.transaction?.hash) {
    throw new ApiError(500, 'FASTFS_NOT_FINALIZED',
      'FastFS envelope did not finalize (no transaction hash in outcome)');
  }
  const status = outcome?.status;
  const failure = status?.Failure ?? status?.failure;
  if (!failure) return; // executed as success — unexpected, but data is on-chain; fine
  const kind = JSON.stringify(failure);
  if (kind.includes('CodeDoesNotExist') && kind.includes(receiver)) return; // the expected no-op
  throw new ApiError(500, 'FASTFS_UNEXPECTED_STATUS',
    `FastFS envelope finalized with an unexpected execution status ` +
    `(expected CodeDoesNotExist at ${receiver}): ${kind.slice(0, 200)}`);
}

// ────────────────────────────────────────────────
// FastfsData borsh schema (byte-layout validated in the Step 0 spike)
// ────────────────────────────────────────────────
// FastfsData::Simple { relative_path: string, content: Option<{ mime_type: string, content: Vec<u8> }> }
//   enum discriminant 0x00 = Simple
//   content Some => option tag 0x01 + { mime_type, content } ; None (delete) => 0x00
// The encoder will use kv.ts's existing borsh helpers (NOT a new borsh dep) so
// there is one borsh implementation in the codebase, not two.
export const FASTFS_METHOD = '__fastdata_fastfs';
const FASTFS_GAS = 300_000_000_000_000n; // 300 TGas (spike-validated; the failed no-op burns far less)

// FastfsData::Simple borsh. Layout validated byte-for-byte in the Step 0 spike.
// Reuses kv.ts's borshString/borshBytes so there is ONE borsh impl in the tree.
export function borshFastfsUpload(rel: string, mime: string, content: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from([0]),        // FastfsData::Simple (enum variant 0)
    borshString(rel),
    Buffer.from([1]),        // content: Option = Some
    borshString(mime),
    borshBytes(content),
  ]);
}

export function borshFastfsDelete(rel: string): Buffer {
  return Buffer.concat([
    Buffer.from([0]),        // FastfsData::Simple
    borshString(rel),
    Buffer.from([0]),        // content: Option = None  → indexer removes the path
  ]);
}

// ────────────────────────────────────────────────
// upload / delete  — data-envelope tx, success = FINALIZATION
// ────────────────────────────────────────────────
// Signs as the KV-owner signer (nova-sdk.near) via the shared broadcaster in
// tolerateFailure mode: the __fastdata call fails with CodeDoesNotExist BY
// DESIGN, so we take the finalized outcome and assert the expected no-op.
// Encryption is the CALLER's job — `ciphertext` is already AES-256-GCM'd with
// the group/file key. FastFS only ever sees opaque bytes.

export async function upload(ciphertext: Uint8Array, groupId: string): Promise<StorageLocation> {
  const rel = newRelativePath(groupId);
  const args = borshFastfsUpload(rel, FASTFS_MIME, ciphertext);
  const outcome = await signAndBroadcastFunctionCall(
    FASTFS_RECEIVER, FASTFS_METHOD, args, FASTFS_GAS, 0n, { tolerateFailure: true },
  );
  assertFastfsEnvelopeFinalized(outcome);
  return { backend: 'fastfs', location: encodeFastfsLocation(rel) };
}

export async function remove(loc: StorageLocation): Promise<void> {
  if (loc.backend !== 'fastfs') {
    throw new ApiError(400, 'BAD_BACKEND', 'remove() supports FastFS locations only');
  }
  const { relativePath } = parseFastfsLocation(loc.location);
  const args = borshFastfsDelete(relativePath);
  const outcome = await signAndBroadcastFunctionCall(
    FASTFS_RECEIVER, FASTFS_METHOD, args, FASTFS_GAS, 0n, { tolerateFailure: true },
  );
  assertFastfsEnvelopeFinalized(outcome);
  // NOTE: this only stops the gateway serving. Real erasure = crypto-shred:
  // destroy the wrapped file key in KV (§5.1/§6.2). Bytes persist in NEAR
  // archival history + FastData KV history regardless.
}

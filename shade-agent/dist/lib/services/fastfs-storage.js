// shade-agent/src/lib/services/fastfs-storage.ts
//
// FastFS storage orchestration, as pure functions — the same service shape as
// user-keys.ts / key-management.ts (no Hono, no HTTP, no Context). Consumed by
// the oRPC procedures in rpc/router.ts.
//
// This is the WRITE/READ path for v1 files (§5.2/§5.3). Key material stays in
// key-management.ts; this module owns path generation, FastFS I/O (via
// lib/fastfs.ts, which signs the envelope as the KV-owner signer), and the
// file-format metadata record. Encryption is the CLIENT's job — Shade only ever
// sees ciphertext.
//
// FLOW (why it's split prepare/finalize):
//   prepare_file_upload → fix the relativePath NOW, mint a random file key keyed
//     to it, hand the key to the client. The path must be fixed here because the
//     file key is keyed by it (§5.1 correction: unique ref, not file_hash).
//   finalize_file_upload → client returns ciphertext + the format it produced;
//     upload to THAT path, persist the format record, return the location for
//     record_transaction(backend=FastFS).
//   retrieve_file → look up the key + fetch the bytes + return the format so the
//     SDK's decodeFile can dispatch (v1). Legacy IPFS is handled by MCP, not here.
//
// file-meta is keyed by file_ref (the relativePath), NOT file_hash — a THIRD
// §5.3 correction, same reason as §5.1: retrieval has the location (→ file_ref),
// not the hash, and keying key+meta by the same ref makes retrieve two clean
// lookups. file_hash stays the on-chain integrity anchor.
import { encryptBlob, decryptBlob, sha256Hex } from '../crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../kv.js';
import { newRelativePath, uploadAt, retrieve, parseFastfsLocation } from '../fastfs.js';
import { generateFileKey, getFileKey } from './key-management.js';
import { log } from '../logger.js';
const fileMetaIdFor = (groupId, fileRef) => sha256Hex(`file-meta:${groupId}:${fileRef}`);
// ────────────────────────────────────────────────
// PREPARE — fix the path, mint the file key
// ────────────────────────────────────────────────
// Auth is enforced inside generateFileKey (authorizeForGroup), identical to the
// group-key path. Returns the file key (for client-side encryption) and the
// file_ref the client must echo back at finalize.
export async function prepareFileUpload(input) {
    const { group_id, token, account_id, contract_id } = input;
    // The path is derived from the group + a random uuid; it becomes the file_ref
    // the file key is keyed by. deriveFastfsPathPrefix needs the master seed, which
    // the withMasterSeed middleware has already loaded.
    const file_ref = newRelativePath(group_id);
    const { file_key, version } = await generateFileKey({
        group_id, file_ref, token, account_id, contract_id,
    });
    log('info', 'fastfs_prepare_upload', {
        group_id, version, file_ref_hash: sha256Hex(file_ref).slice(0, 12),
    });
    return { file_key, file_ref, version };
}
// ────────────────────────────────────────────────
// FINALIZE — upload ciphertext to the fixed path, persist format
// ────────────────────────────────────────────────
// `encrypted_b64` is the v1 ciphertext the client produced with the file key.
// `format` is the FileFormatV1 the SDK's encodeFile emitted. We upload, store the
// format record (TEE-encrypted, keyed by file_ref), and return the location for
// the caller's record_transaction(backend=FastFS).
export async function finalizeFileUpload(input) {
    const { group_id, file_ref, encrypted_b64, format } = input;
    const ciphertext = Buffer.from(encrypted_b64, 'base64');
    // Signs the envelope as the KV-owner signer; success = NEAR finalization.
    const { backend, location } = await uploadAt(new Uint8Array(ciphertext), file_ref);
    // Persist the format record so retrieve can hand the SDK what decodeFile needs.
    const metaRecord = JSON.stringify({ format: format ?? null });
    await storeBlobToKV(fileMetaIdFor(group_id, file_ref), encryptBlob(Buffer.from(metaRecord, 'utf8')));
    log('info', 'fastfs_finalize_upload', {
        group_id, backend, file_ref_hash: sha256Hex(file_ref).slice(0, 12),
    });
    return { location, backend };
}
// ────────────────────────────────────────────────
// RETRIEVE — key + ciphertext + format for the SDK's decodeFile
// ────────────────────────────────────────────────
// Takes the FastFS `location` (from the on-chain record). Derives file_ref from
// it, fetches the file key (auth enforced in getFileKey — throws FILE_DELETED if
// tombstoned), fetches the ciphertext from the gateway, and returns the stored
// format. Legacy IPFS files never reach here — MCP routes CIDs to the group-key
// path.
export async function retrieveFile(input) {
    const { group_id, location, token, account_id, contract_id } = input;
    const { relativePath: file_ref } = parseFastfsLocation(location);
    // File key (also the tombstone/deletion gate) — authorizes the caller.
    const { file_key, version } = await getFileKey({
        group_id, file_ref, token, account_id, contract_id,
    });
    // Ciphertext from the gateway (or self-hosted reader). Shade fetches so all
    // FastFS logic stays in lib/fastfs.ts and the SDK change stays minimal.
    const bytes = await retrieve({ backend: 'fastfs', location });
    const encrypted_b64 = Buffer.from(bytes).toString('base64');
    // Format record (absent ⇒ null; the SDK treats null as v0, but a FastFS file
    // should always have one — absence means an older finalize path).
    let format = null;
    const metaBlob = await getBlobFromKV(fileMetaIdFor(group_id, file_ref));
    if (metaBlob) {
        const parsed = JSON.parse(Buffer.from(decryptBlob(metaBlob)).toString('utf8'));
        format = (parsed?.format ?? null);
    }
    log('info', 'fastfs_retrieve_file', {
        group_id, version, file_ref_hash: sha256Hex(file_ref).slice(0, 12),
    });
    return { file_key, encrypted_b64, location, group_id, format };
}

// shade-agent/src/lib/services/key-management.ts
//
// Group-key operations, as pure functions. No Hono, no HTTP, no Context.
// Consumed by both the Hono routes and the oRPC procedures.
//
// CONTRACT: input is already Zod-validated; failures throw ApiError; success
// returns exactly the body the route used to emit.
import crypto from 'crypto';
import { encryptBlob, decryptBlob, deriveKey, sha256Hex, gcmWrap, gcmUnwrap } from '../crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../kv.js';
import { getRpcUrl, viewFunction, resolveContract } from '../near.js';
import { verifyToken } from '../auth.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';
// Group keys are derived, never stored:
//   unrotated: group:{group_id}:{network}:{contract}
//   rotated:   group:{group_id}:{network}:{contract}:v{version}
// The current version lives in KV under group-version:{...}. Rotation therefore
// costs one KV write, not an O(N-files) re-encryption (roadmap §5.1).
const groupSalt = (groupId, network, contractId, version) => version
    ? `group:${groupId}:${network}:${contractId}:v${version}`
    : `group:${groupId}:${network}:${contractId}`;
const versionKeyIdFor = (groupId, network, contractId) => sha256Hex(`group-version:${groupId}:${network}:${contractId}`);
/** Read the current group key version from KV, or null if never rotated. */
async function currentVersion(groupId, network, contractId) {
    const versionBlob = await getBlobFromKV(versionKeyIdFor(groupId, network, contractId));
    if (!versionBlob)
        return null;
    const combined = JSON.parse(Buffer.from(decryptBlob(versionBlob)).toString('utf8'));
    return combined.version ?? null;
}
/** Derive a fresh version, store it, return it. Used by both revoke and rotate. */
async function rotateTo(groupId, network, contractId, version) {
    const newKeyBytes = deriveKey(groupSalt(groupId, network, contractId, String(version)), 32);
    // NOTE: the stored blob nests an encrypted key inside an encrypted envelope.
    // Redundant (the key is derivable from the salt anyway) but preserved verbatim
    // — changing the stored shape would orphan every rotated group.
    const combined = JSON.stringify({ key: encryptBlob(newKeyBytes), version: String(version) });
    await storeBlobToKV(versionKeyIdFor(groupId, network, contractId), encryptBlob(Buffer.from(combined, 'utf8')));
    return newKeyBytes;
}
// ────────────────────────────────────────────────
// GENERATE KEY
// ────────────────────────────────────────────────
export async function generateGroupKey(input) {
    const { group_id, contract_id } = input;
    const { contractId, network } = resolveContract(contract_id);
    const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
    if (!groupExists)
        throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found on ${contractId}`);
    const salt = groupSalt(group_id, network, contractId);
    const keyBytes = deriveKey(salt, 32);
    await storeBlobToKV(sha256Hex(salt), encryptBlob(keyBytes));
    return {
        key: Buffer.from(keyBytes).toString('base64'),
        checksum: 'derived-' + crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 16),
    };
}
// ────────────────────────────────────────────────
// GET KEY
// ────────────────────────────────────────────────
export async function getGroupKey(input) {
    const { group_id, token, account_id, contract_id } = input;
    const { contractId, network } = resolveContract(contract_id, group_id);
    // TWO AUTH PATHS (roadmap §8.7 — converge in v0.5):
    //   account_id → trusted because the caller cleared the X-Internal-Auth gate
    //                (MCP signing on a user's behalf; no user token exists).
    //   token      → NOVA ephemeral token, verified against on-chain access keys.
    let user_id;
    if (account_id) {
        user_id = account_id;
    }
    else {
        if (!token)
            throw new ApiError(400, 'AUTH_REQUIRED', 'account_id or token required');
        const tokenInfo = await verifyToken(token, contractId, network);
        if (!tokenInfo.valid || !tokenInfo.user_id) {
            throw new ApiError(403, 'INVALID_TOKEN', 'Invalid token');
        }
        user_id = tokenInfo.user_id;
    }
    const authorized = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
    if (!authorized)
        throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
    const version = await currentVersion(group_id, network, contractId);
    const keyBytes = deriveKey(groupSalt(group_id, network, contractId, version), 32);
    return { key: Buffer.from(keyBytes).toString('base64'), checksum: 'derived-verified' };
}
// ────────────────────────────────────────────────
// ROTATE KEY
// ────────────────────────────────────────────────
export async function rotateGroupKey(input) {
    const { group_id, contract_id } = input;
    const { contractId, network } = resolveContract(contract_id, group_id);
    const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
    if (!groupExists)
        throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found (${contractId})`);
    const version = Date.now();
    const newKeyBytes = await rotateTo(group_id, network, contractId, version);
    // Audit event - group_id stays unhashed at group key rotation (not risky, useful for debugging).
    log('info', 'group_key_rotated', { group_id, version, network, contract_id: contractId });
    return {
        success: true,
        new_key_hash: crypto.createHash('sha256').update(newKeyBytes).digest('hex'),
        version,
        checksum: 'derived-verified',
    };
}
// ════════════════════════════════════════════════════════════════════════════
// §5.1 — PER-FILE KEYS (v0.5 Step 2)
// ════════════════════════════════════════════════════════════════════════════
//
// Three-tier hierarchy: master seed → group key v{N} → file key.
//
// TWO CORRECTIONS to §5.1 as originally written, both forced by crypto-shred:
//   • The file key is RANDOM per file, NOT HKDF(group_key, "file:{hash}"). A
//     derived key is re-derivable from the master seed forever, so it could
//     never be destroyed and §6.2 deletion would be impossible. The random key
//     lives ONLY as the wrapped blob in KV; destroying that blob shreds it.
//   • Keyed by a per-upload-UNIQUE ref (the FastFS relativePath), NOT file_hash.
//     Identical files share a hash; hash-keying would let a second upload
//     overwrite and orphan the first's key. file_hash stays the on-chain
//     integrity field (record_transaction), separate from the key id.
//
//   wrap  = gcmWrap(random_file_key, group_key_v{N})
//   store = KV[ sha256(file-key:{group_id}:{file_ref}) ]
//             = encryptBlob(JSON{ v:N|null, w:wrap_hex })      // TEE layer (KV convention)
//   The embedded version N pins which group key unwraps it; a later rotation
//   does NOT re-wrap or orphan past files (§5.1: no eager re-wrapping).
//
// DELETION (§6.2 calls tombstoneFileKey; mechanism proven here): overwrite the
// slot with TOMBSTONE via the EXISTING storeBlobToKV write path — NOT rotate_key
// (rotating leaves v{N} derivable, so it deletes nothing and is group-wide).
// getFileKey then returns FILE_DELETED. Residual: the original store tx persists
// in NEAR archival history, unwrappable only by an attacker who ALSO holds
// group_key_v{N} — the same immutable-ledger residue as the FastFS ciphertext;
// "put beyond use", not information-theoretic erasure.
const TOMBSTONE = Buffer.from('NOVA_FILE_TOMBSTONE_v1', 'utf8');
/** Exposed for the Step 2 harness only. */
export const _FILE_TOMBSTONE = TOMBSTONE;
function fileKeyIdFor(groupId, fileRef) {
    return sha256Hex(`file-key:${groupId}:${fileRef}`);
}
// Authorize the caller for the group — identical to getGroupKey's two auth paths
// (account_id trusted behind the X-Internal-Auth gate; else a verified token).
async function authorizeForGroup(groupId, contractId, network, token, accountId) {
    let user_id;
    if (accountId) {
        user_id = accountId;
    }
    else {
        if (!token)
            throw new ApiError(400, 'AUTH_REQUIRED', 'account_id or token required');
        const tokenInfo = await verifyToken(token, contractId, network);
        if (!tokenInfo.valid || !tokenInfo.user_id)
            throw new ApiError(403, 'INVALID_TOKEN', 'Invalid token');
        user_id = tokenInfo.user_id;
    }
    const authorized = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id: groupId, user_id });
    if (!authorized)
        throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
}
// ── GENERATE FILE KEY (at upload) ──
// Wraps a fresh RANDOM file key under the current group key version and stores
// it. Returns the file key to the authorized uploader for client-side AES-GCM.
export async function generateFileKey(input) {
    const { group_id, file_ref, token, account_id, contract_id } = input;
    const { contractId, network } = resolveContract(contract_id, group_id);
    await authorizeForGroup(group_id, contractId, network, token, account_id);
    const version = await currentVersion(group_id, network, contractId); // string | null
    const groupKey = deriveKey(groupSalt(group_id, network, contractId, version), 32);
    const fileKey = crypto.randomBytes(32);
    const wrapped = gcmWrap(fileKey, groupKey);
    const record = JSON.stringify({ v: version, w: wrapped });
    await storeBlobToKV(fileKeyIdFor(group_id, file_ref), encryptBlob(Buffer.from(record, 'utf8')));
    log('info', 'file_key_generated', {
        group_id, version, file_ref_hash: sha256Hex(file_ref).slice(0, 12),
    });
    return {
        file_key: Buffer.from(fileKey).toString('base64'),
        version: version ?? 'base',
        file_key_id: fileKeyIdFor(group_id, file_ref),
    };
}
// ── GET FILE KEY (at retrieve) ──
export async function getFileKey(input) {
    const { group_id, file_ref, token, account_id, contract_id } = input;
    const { contractId, network } = resolveContract(contract_id, group_id);
    await authorizeForGroup(group_id, contractId, network, token, account_id);
    const blob = await getBlobFromKV(fileKeyIdFor(group_id, file_ref));
    if (!blob)
        throw new ApiError(404, 'FILE_KEY_NOT_FOUND', 'No key for this file');
    const decrypted = Buffer.from(decryptBlob(blob));
    // 404 (not 410 — 410 is not in ApiStatus). The `code` disambiguates
    // "deleted" from "never existed".
    if (decrypted.equals(TOMBSTONE))
        throw new ApiError(404, 'FILE_DELETED', 'File deleted');
    const { v, w } = JSON.parse(decrypted.toString('utf8'));
    const groupKey = deriveKey(groupSalt(group_id, network, contractId, v), 32);
    const fileKey = gcmUnwrap(w, groupKey); // GCM auth tag fails if v/group key is wrong
    return { file_key: Buffer.from(fileKey).toString('base64'), version: v ?? 'base' };
}
// ── TOMBSTONE (crypto-shred) — mechanism for §6.2 / §5.7; wired there ──
// No auth arg: callers (retention job / DeleteMemberFiles) authorize at their
// layer (owner / retention policy). Reuses the existing storeBlobToKV path.
export async function tombstoneFileKey(groupId, fileRef) {
    await storeBlobToKV(fileKeyIdFor(groupId, fileRef), encryptBlob(TOMBSTONE));
    log('info', 'file_key_tombstoned', {
        group_id: groupId, file_ref_hash: sha256Hex(fileRef).slice(0, 12),
    });
}

// shade-agent/src/lib/services/key-management.ts
//
// Group-key operations, as pure functions. No Hono, no HTTP, no Context.
// Consumed by both the Hono routes and the oRPC procedures.
//
// CONTRACT: input is already Zod-validated; failures throw ApiError; success
// returns exactly the body the route used to emit.

import crypto from 'crypto';
import type { z } from 'zod';

import { encryptBlob, decryptBlob, deriveKey, sha256Hex } from '../crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../kv.js';
import { getRpcUrl, viewFunction, resolveContract } from '../near.js';
import { verifyToken } from '../auth.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';
import type {
  GenerateKeySchema, GetKeySchema, RotateKeySchema,
} from '../schemas.js';

type GenerateKeyInput = z.infer<typeof GenerateKeySchema>;
type GetKeyInput = z.infer<typeof GetKeySchema>;
type RotateKeyInput = z.infer<typeof RotateKeySchema>;

// Group keys are derived, never stored:
//   unrotated: group:{group_id}:{network}:{contract}
//   rotated:   group:{group_id}:{network}:{contract}:v{version}
// The current version lives in KV under group-version:{...}. Rotation therefore
// costs one KV write, not an O(N-files) re-encryption (roadmap §5.1).
const groupSalt = (groupId: string, network: string, contractId: string, version?: string | null) =>
  version
    ? `group:${groupId}:${network}:${contractId}:v${version}`
    : `group:${groupId}:${network}:${contractId}`;

const versionKeyIdFor = (groupId: string, network: string, contractId: string) =>
  sha256Hex(`group-version:${groupId}:${network}:${contractId}`);

/** Read the current group key version from KV, or null if never rotated. */
async function currentVersion(
  groupId: string, network: string, contractId: string,
): Promise<string | null> {
  const versionBlob = await getBlobFromKV(versionKeyIdFor(groupId, network, contractId));
  if (!versionBlob) return null;
  const combined = JSON.parse(Buffer.from(decryptBlob(versionBlob)).toString('utf8'));
  return combined.version ?? null;
}

/** Derive a fresh version, store it, return it. Used by both revoke and rotate. */
async function rotateTo(
  groupId: string, network: string, contractId: string, version: number,
): Promise<Uint8Array> {
  const newKeyBytes = deriveKey(groupSalt(groupId, network, contractId, String(version)), 32);
  // NOTE: the stored blob nests an encrypted key inside an encrypted envelope.
  // Redundant (the key is derivable from the salt anyway) but preserved verbatim
  // — changing the stored shape would orphan every rotated group.
  const combined = JSON.stringify({ key: encryptBlob(newKeyBytes), version: String(version) });
  await storeBlobToKV(
    versionKeyIdFor(groupId, network, contractId),
    encryptBlob(Buffer.from(combined, 'utf8')),
  );
  return newKeyBytes;
}

// ────────────────────────────────────────────────
// GENERATE KEY
// ────────────────────────────────────────────────

export async function generateGroupKey(input: GenerateKeyInput) {
  const { group_id, contract_id } = input;
  const { contractId, network } = resolveContract(contract_id);

  const groupExists = await viewFunction(
    getRpcUrl(network), contractId, 'group_contains_key', { group_id },
  );
  if (!groupExists) throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found on ${contractId}`);

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

export async function getGroupKey(input: GetKeyInput) {
  const { group_id, token, account_id, contract_id } = input;
  const { contractId, network } = resolveContract(contract_id, group_id);

  // TWO AUTH PATHS (roadmap §8.7 — converge in v0.5):
  //   account_id → trusted because the caller cleared the X-Internal-Auth gate
  //                (MCP signing on a user's behalf; no user token exists).
  //   token      → NOVA ephemeral token, verified against on-chain access keys.
  let user_id: string;
  if (account_id) {
    user_id = account_id;
  } else {
    if (!token) throw new ApiError(400, 'AUTH_REQUIRED', 'account_id or token required');
    const tokenInfo = await verifyToken(token, contractId, network);
    if (!tokenInfo.valid || !tokenInfo.user_id) {
      throw new ApiError(403, 'INVALID_TOKEN', 'Invalid token');
    }
    user_id = tokenInfo.user_id;
  }

  const authorized = await viewFunction(
    getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id },
  );
  if (!authorized) throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');

  const version = await currentVersion(group_id, network, contractId);
  const keyBytes = deriveKey(groupSalt(group_id, network, contractId, version), 32);

  return { key: Buffer.from(keyBytes).toString('base64'), checksum: 'derived-verified' };
}

// ────────────────────────────────────────────────
// ROTATE KEY
// ────────────────────────────────────────────────

export async function rotateGroupKey(input: RotateKeyInput) {
  const { group_id, contract_id } = input;
  const { contractId, network } = resolveContract(contract_id, group_id);

  const groupExists = await viewFunction(
    getRpcUrl(network), contractId, 'group_contains_key', { group_id },
  );
  if (!groupExists) throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found (${contractId})`);

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
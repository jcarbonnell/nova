// shade-agent/src/lib/services/retention.ts
//
// §6.1 retention-group REGISTRY — the off-chain index of which groups have a
// retention window, so the expiry driver knows which groups to check.
//
// WHY THIS EXISTS: the contract's retention_windows is a LookupMap, which is NOT
// iterable — there is no on-chain "list all groups with a window". So the driver
// needs an off-chain candidate list. This mirrors how the contract itself keeps
// owned_groups/member_groups as separate indexes precisely because the primary
// maps can't be enumerated.
//
// INVARIANT (registry ⊇ on-chain windows, never a subset): the registry may
// over-include but must never under-include. An extra entry is harmless — the
// driver confirms each against get_group_retention (free view) and skips any
// that return None. A MISSING entry is the dangerous case: a silently
// unenforced window, undiscoverable because on-chain windows can't be
// enumerated. The registry-FIRST write ordering in MCP's set_group_retention is
// what guarantees the safe direction (register before the window can exist
// on-chain). This service just maintains the set idempotently.
//
// Pure functions, no HTTP/Context — same contract as the other lib/services/*:
// Zod-validated input in, ApiError on failure, plain object out.

import type { z } from 'zod';

import { encryptBlob, decryptBlob } from '../crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../kv.js';
import { log } from '../logger.js';
import type { RetentionRegisterSchema } from '../schemas.js';
import { getRpcUrl, resolveContract } from '../near.js';
import { rpcCallWithRetry } from '../kv.js';

type RetentionRegisterInput = z.infer<typeof RetentionRegisterSchema>;

// Fixed singleton key. Unlike user/file blobs this is not a per-entity id, so it
// is a well-known constant, not a sha256(...) hash. One blob, one JSON array.
// Overridable ONLY so the harness can exercise real KV under a throwaway key
// without mutating the production singleton; unset in production ⇒ the constant.
const REGISTRY_KEY = process.env.RETENTION_REGISTRY_KEY || 'retention-registry';

/** Read the registry array, or [] if it has never been written. */
async function readRegistry(): Promise<string[]> {
  const blob = await getBlobFromKV(REGISTRY_KEY);
  if (!blob) return [];
  const arr = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
  return Array.isArray(arr) ? arr : [];
}

/** Overwrite the registry array (encrypted, like every KV blob). */
async function writeRegistry(groups: string[]): Promise<void> {
  await storeBlobToKV(REGISTRY_KEY, encryptBlob(Buffer.from(JSON.stringify(groups), 'utf8')));
}

/**
 * Add a group to the registry. Idempotent (set-union). MUST succeed before the
 * on-chain window is set (MCP calls this first) so the registry can never miss a
 * real window. Throws (via storeBlobToKV) if the KV write fails, so MCP aborts
 * the whole set_group_retention rather than creating an unregistered window.
 *
 * CONCURRENCY: read-modify-write on the single blob is last-write-wins. Two
 * simultaneous registers could drop one entry. retention-set is a rare admin
 * action, so this is accepted for now; flagged for a per-group-key scheme if it
 * ever becomes contended.
 */
export async function registerRetentionGroup(input: RetentionRegisterInput) {
  const { group_id } = input;
  const groups = await readRegistry();
  if (groups.includes(group_id)) {
    log('info', 'retention_register_noop', { group_id, size: groups.length });
    return { registered: true, already_present: true, size: groups.length };
  }
  groups.push(group_id);
  await writeRegistry(groups);
  log('info', 'retention_registered', { group_id, size: groups.length });
  return { registered: true, already_present: false, size: groups.length };
}

/**
 * Remove a group from the registry. Idempotent (filter). Best-effort from MCP's
 * side on a window CLEAR: if this fails, the stale entry is harmless — the driver
 * filters it via get_group_retention returning None. So a failed deregister must
 * NOT block the clear.
 */
export async function deregisterRetentionGroup(input: RetentionRegisterInput) {
  const { group_id } = input;
  const groups = await readRegistry();
  if (!groups.includes(group_id)) {
    log('info', 'retention_deregister_noop', { group_id, size: groups.length });
    return { deregistered: true, was_present: false, size: groups.length };
  }
  const next = groups.filter((g) => g !== group_id);
  await writeRegistry(next);
  log('info', 'retention_deregistered', { group_id, size: next.length });
  return { deregistered: true, was_present: true, size: next.length };
}

/** The driver's candidate list (Piece 2 consumes this). */
export async function listRetentionGroups(): Promise<string[]> {
  return readRegistry();
}

// ════════════════════════════════════════════════════════════════════════════
// §6.1 — RETENTION SCAN (Piece 2, READ-ONLY / dry-run)
// ════════════════════════════════════════════════════════════════════════════
//
// Reports what a retention sweep WOULD tombstone, destroying NOTHING. This is
// the "prove before automating" layer: no crypto-shred, no FastFS write, no
// on-chain tombstone lives in this path. The destructive execute path is a
// SEPARATE route added in Piece 3.
//
// Per run:
//   1. registry (KV, one read) → candidate groups.
//   2. per group: get_group_retention (free contract view). null ⇒ SKIP — this
//      is the superset-invariant filter: a stale registry entry (window later
//      cleared, or a failed on-chain set after a registry-first write) returns
//      null here and is harmlessly ignored, never acted on.
//   3. per live-window group: get_expired_transactions (free contract view) →
//      the FastFS tx_ids whose upload age exceeds the window.
//   4. report the plan.
//
// All free views + one KV read. No writes, so no finality-lag concern.
// NOTE (roadmap §6.1): get_expired_transactions iterates a group's tx index;
// add offset/limit pagination before any group reaches many-thousands of txs.

export interface ScanGroupResult {
  group_id: string;
  retention_days: number | null;   // null ⇒ skipped (no live window)
  expired_trans_ids: string[];     // [] when none expired or when skipped
  skipped_reason?: string;         // present iff the group was skipped
  error?: string;                  // present iff a view call failed for this group
}

export interface ScanResult {
  scanned_at: string;
  registry_size: number;
  groups: ScanGroupResult[];
  total_expired: number;           // sum of expired_trans_ids across live groups
}

// A view call that DISTINGUISHES an RPC failure from a genuine null result.
// lib/near.ts's viewFunction collapses both to null (§7.7); for a compliance
// sweep that conflation is dangerous — an RPC blip would look like "no window"
// and the group's expired data would silently never be swept. So we call
// rpcCallWithRetry directly (it THROWS on RPC error, after 3 backed-off tries)
// and decode the view result ourselves. Throw ⇒ RPC failure (surfaced per-group
// as `error`, never silently skipped). Returned value ⇒ authoritative on-chain
// answer (including a genuine null for "no window").
async function viewOrThrow(
  rpcUrl: string, contractId: string, methodName: string, args: Record<string, unknown>,
): Promise<unknown> {
  const result = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0',
    id: 'retention-view',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  }) as { result?: number[] };

  // A NEAR call_function view returns the value as a byte array in `result`.
  // Empty array ⇒ the method returned nothing serializable (shouldn't happen for
  // these Option/Vec-returning views, which serialize null/[] explicitly).
  if (!result?.result || result.result.length === 0) return null;
  return JSON.parse(Buffer.from(result.result).toString('utf8'));
}

/**
 * Read-only retention scan. Never mutates anything. `contract_id` optional,
 * resolves to mainnet NOVA by default (same as key-management).
 *
 * FAILURE MODEL (deliberate, resolves §7.7 for this path):
 *   • A per-group RPC failure THROWS out of viewOrThrow, is caught here, and is
 *     reported in that group's `error` field with retention_days:null and no
 *     expired ids — DISTINCT from a genuine "no window" skip. The operator sees
 *     "error" vs "skipped_reason" and knows the difference. One bad group never
 *     aborts the scan or masquerades as "nothing to delete".
 *   • A genuine null from get_group_retention ⇒ skipped_reason (no live window):
 *     the superset-invariant filter for a stale registry entry.
 */
export async function scanRetention(input: { contract_id?: string }): Promise<ScanResult> {
  const groups = await readRegistry();
  const { contractId, network } = resolveContract(input.contract_id);
  const rpcUrl = getRpcUrl(network);

  const results: ScanGroupResult[] = [];
  let totalExpired = 0;

  for (const group_id of groups) {
    try {
      const retention_days = await viewOrThrow(
        rpcUrl, contractId, 'get_group_retention', { group_id },
      ) as number | null;

      // Genuine null ⇒ no live window (cleared, or stale registry entry). Skip.
      if (retention_days === null || retention_days === undefined) {
        results.push({
          group_id,
          retention_days: null,
          expired_trans_ids: [],
          skipped_reason: 'no live retention window on-chain (cleared or stale registry entry)',
        });
        continue;
      }

      const expired = await viewOrThrow(
        rpcUrl, contractId, 'get_expired_transactions', { group_id },
      ) as string[] | null;

      const expired_trans_ids = Array.isArray(expired) ? expired : [];
      totalExpired += expired_trans_ids.length;
      results.push({ group_id, retention_days, expired_trans_ids });
    } catch (err) {
      // RPC failure for THIS group — reported, NOT silently skipped. This is the
      // distinction §7.7's null-collapse loses. Deletion is never implied by an
      // error; the operator (and Piece 3) must treat `error` groups as "unknown,
      // retry", never as "nothing to delete".
      results.push({
        group_id,
        retention_days: null,
        expired_trans_ids: [],
        error: (err as Error).message,
      });
    }
  }

  return {
    scanned_at: new Date().toISOString(),
    registry_size: groups.length,
    groups: results,
    total_expired: totalExpired,
  };
}
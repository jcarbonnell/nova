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
import { getBlobFromKV, storeBlobToKV, rpcCallWithRetry, signAndBroadcastFunctionCall } from '../kv.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';
import type { RetentionRegisterSchema, RetentionExecuteSchema } from '../schemas.js';
import { getRpcUrl, resolveContract } from '../near.js';
import { tombstoneFileKey } from './key-management.js';
import { remove, parseFastfsLocation } from '../fastfs.js';

type RetentionRegisterInput = z.infer<typeof RetentionRegisterSchema>;
type RetentionExecuteInput = z.infer<typeof RetentionExecuteSchema>;

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

// Exported (underscore convention would be _viewOrThrow, but it's used internally
// by scanRetention too, so we keep the name and just export it) so the Piece 2
// harness can prove a transport error THROWS here — the §7.7 distinction — without
// the shared-RPC-URL problem that makes it untestable through scanRetention
// (KV_RPC_URL === NEAR_RPC_URL in config.ts, so a dead URL also kills seed load).
export async function viewOrThrow(
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

// ════════════════════════════════════════════════════════════════════════════
// §6.1 / §6.2 — RETENTION EXECUTE (Piece 3). The IRREVERSIBLE destroy path.
// ════════════════════════════════════════════════════════════════════════════
//
// Separate FUNCTIONS from the read-only scan (though same file). The destroy
// primitives are invoked ONLY here; scan never deletes.
//
// KEY-FIRST ordering per file (fail-safe, same rationale as the registry-first
// invariant): the crypto-shred IS the deletion. If the process dies mid-sequence
// the file is already unrecoverable (goal achieved) and a re-run finishes the
// bookkeeping. On-chain-first would risk the audit record claiming "deleted"
// while the file is still recoverable — the wrong direction for a compliance
// feature. Steps:
//   1. tombstoneFileKey(group, fileRef)  — crypto-shred the wrapped file key (KV).
//   2. remove({backend:'fastfs', location}) — FastFS null-write (cosmetic).
//   3. tombstone_transactions([trans_id], RetentionPolicy) — on-chain audit mark.
//
// All three sign as nova-sdk.near (KV-owner signer = NOVA contract owner), so the
// tombstone_transactions owner-gate passes for ANY group, AND the owner-gated
// get_expired_transactions_detailed read (below) authorizes.
//
// Idempotent / resumable: re-running after a partial failure is safe — shredding
// an already-shredded key is harmless, the contract tombstone keeps the first
// record, FastFS remove of a gone path is a no-op.
//
// CONFIRM FLAG: without { confirm: true } this returns the PLAN and destroys
// NOTHING (dry-run echo) — the extra deliberate step for an irreversible op.

const NOVA_GAS = 100_000_000_000_000n; // 100 TGas — matches MCP's call_contract default

// Decode the SuccessValue (base64 JSON) from a signed-call broadcast result.
// broadcast_tx_commit returns a top-level `status` object; a successful function
// call's return value is status.SuccessValue, base64-encoded (NEAR RPC docs).
// signAndBroadcastFunctionCall throws on Failure by default, so reaching here is
// success; we just pull the value out.
function decodeSuccessValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string } })?.status;
  const sv = status?.SuccessValue;
  if (sv === undefined || sv === null || sv === '') return null;
  return JSON.parse(Buffer.from(sv, 'base64').toString('utf8'));
}

// Signed read of the OWNER-GATED detailed view (contract v0.3.6). Returns
// [[trans_id, location], ...] for expired FastFS files. Signed as nova-sdk.near
// (contract owner) so the gate passes. NOT a free view (ProhibitedInView).
async function fetchExpiredDetailed(
  contractId: string, groupId: string,
): Promise<Array<[string, string]>> {
  const args = Buffer.from(JSON.stringify({ group_id: groupId }));
  const outcome = await signAndBroadcastFunctionCall(
    contractId, 'get_expired_transactions_detailed', args, NOVA_GAS, 0n,
  );
  const decoded = decodeSuccessValue(outcome);
  if (!Array.isArray(decoded)) return [];
  return decoded as Array<[string, string]>;
}

export interface ExecuteFileResult {
  trans_id: string;
  location: string;
  destroyed: boolean;              // true iff the file key was crypto-shredded
  bookkeeping_incomplete?: boolean; // key shredded (data gone) but step 2/3 failed
  error?: string;
}

export interface ExecuteResult {
  group_id: string;
  confirmed: boolean;             // false ⇒ dry-run (nothing destroyed)
  candidates: number;
  results: ExecuteFileResult[];
  destroyed_count: number;
}

/**
 * Execute (or dry-run) a retention sweep for ONE group (per-group scope = tight
 * blast radius). Without confirm:true, returns the plan and destroys nothing.
 *
 * Q3 reporting (data-centric): if the crypto-shred (step 1) SUCCEEDS but a later
 * step fails, the DATA IS GONE — so destroyed:true, with bookkeeping_incomplete
 * flagging that a re-run is needed to finish the audit tombstone. A compliance
 * reader sees destroyed:true accurately (the file is unrecoverable); the flag
 * drives the re-run. Only a step-1 failure is destroyed:false (nothing shredded).
 */
export async function executeRetention(input: RetentionExecuteInput): Promise<ExecuteResult> {
  const { group_id, confirm, contract_id } = input;
  const { contractId } = resolveContract(contract_id);

  const expired = await fetchExpiredDetailed(contractId, group_id);

  // DRY-RUN: no confirm ⇒ echo the plan, destroy nothing.
  if (!confirm) {
    return {
      group_id,
      confirmed: false,
      candidates: expired.length,
      results: expired.map(([trans_id, location]) => ({ trans_id, location, destroyed: false })),
      destroyed_count: 0,
    };
  }

  const results: ExecuteFileResult[] = [];
  let destroyed = 0;

  for (const [trans_id, location] of expired) {
    // fileRef = the FastFS relativePath (how §5.1 keyed the file key).
    let relativePath: string;
    try {
      ({ relativePath } = parseFastfsLocation(location));
    } catch (err) {
      // A malformed/legacy location we can't parse — nothing shredded, safe.
      results.push({ trans_id, location, destroyed: false, error: `bad location: ${(err as Error).message}` });
      log('warn', 'retention_file_bad_location', { group_id, trans_id: trans_id.slice(0, 12) });
      continue;
    }

    // STEP 1 — KEY-FIRST crypto-shred. THE deletion. Throws if not confirmed final.
    try {
      await tombstoneFileKey(group_id, relativePath);
    } catch (err) {
      // Step-1 failure ⇒ nothing destroyed for this file (safe direction).
      results.push({ trans_id, location, destroyed: false, error: `shred failed: ${(err as Error).message}` });
      log('warn', 'retention_shred_failed', { group_id, trans_id: trans_id.slice(0, 12), error: (err as Error).message });
      continue;
    }

    // Past here the KEY IS SHREDDED — the file is unrecoverable (destroyed:true).
    // Steps 2/3 are bookkeeping; a failure sets bookkeeping_incomplete for re-run.
    destroyed++;
    let bookkeepingError: string | undefined;

    // STEP 2 — FastFS null-write (cosmetic serving cleanup).
    try {
      await remove({ backend: 'fastfs', location });
    } catch (err) {
      bookkeepingError = `fastfs remove failed: ${(err as Error).message}`;
    }

    // STEP 3 — on-chain tombstone (audit trail). Per-file (Q4: batch later if cost).
    if (!bookkeepingError) {
      try {
        const args = Buffer.from(JSON.stringify({ trans_ids: [trans_id], reason: 'RetentionPolicy' }));
        await signAndBroadcastFunctionCall(contractId, 'tombstone_transactions', args, NOVA_GAS, 0n);
      } catch (err) {
        bookkeepingError = `on-chain tombstone failed: ${(err as Error).message}`;
      }
    }

    if (bookkeepingError) {
      results.push({ trans_id, location, destroyed: true, bookkeeping_incomplete: true, error: bookkeepingError });
      log('warn', 'retention_bookkeeping_incomplete', { group_id, trans_id: trans_id.slice(0, 12), error: bookkeepingError });
    } else {
      results.push({ trans_id, location, destroyed: true });
      log('info', 'retention_file_destroyed', { group_id, trans_id: trans_id.slice(0, 12) });
    }
  }

  return {
    group_id,
    confirmed: true,
    candidates: expired.length,
    results,
    destroyed_count: destroyed,
  };
}
// shade-agent/src/lib/services/access-windows.ts
//
// §6.1 Piece 4 — per-member ACCESS WINDOWS ("sell a window, not a copy").
//
// A custodial group owner adds a member with access_minutes; the window is
// recorded HERE (encrypted KV) BEFORE the on-chain add (MCP enforces that
// ordering). The scheduler (S3) sweeps due entries: revoke as the owner, rotate
// the group key, then completeAccessWindow() removes the entry.
//
// STORAGE: one encrypted blob per (contract, group):
//   KV[ sha256("{NS}:{contract_id}:{group_id}") ] = { contract_id, group_id, entries: { member: {expires_at_ms, set_at_ms} } }
// plus an index blob KV["{NS}-index"] = [{ contract_id, group_id }, ...] so the
// sweep can enumerate groups (KV, like LookupMap, is not iterable).
//
// INVARIANT (index ⊇ groups with live windows): the index is written BEFORE the
// group blob, and a group leaves the index only AFTER its blob is written empty.
// An extra index entry is harmless (empty group, skipped); a missing one would be
// a silently unenforced window — the same safe direction as the retention registry.
//
// CONCURRENCY — why a lock AND a cache (neither alone is enough):
//   • Reads at finality:'final' lag a committed write by ~1-2s (seen in the S1.2
//     harness run). A read-modify-write right after a write reads stale state and
//     its write-back drops the earlier change — even if the two are serialized.
//   • So Shade (the ONLY writer) keeps an in-memory WRITE-THROUGH cache: loaded
//     once per blob via the STRICT reader, then authoritative for the life of the
//     process. The cache is updated only after the KV write commits.
//   • Every public op — loads included — runs under one in-process lock, so a slow
//     load can never land after a write and overwrite the cache with stale data.
//   After a restart >2s have passed, so the reload from KV is current.
//
// ⚠️ SINGLE-PROCESS INVARIANT: correct only while exactly ONE Shade process
// writes these blobs (true today: one CVM, one Node process). Running replicas
// would need a different scheme. Throughput: one global lock, ~2.2s per KV write
// → roughly 25 window-adds/minute. Fine for now; per-group locking is the upgrade.
//
// CORRUPTION: unlike the retention registry (which reads garbage as []), a
// corrupt blob here THROWS. Reading it as empty and writing back would erase
// every window in the group — the dangerous direction.

import { encryptBlob, decryptBlob, sha256Hex, hashForLog } from '../crypto.js';
import { getBlobFromKVStrict, storeBlobToKV } from '../kv.js';
import { resolveContract } from '../near.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';

// Overridable ONLY so the harness can use a throwaway namespace (same pattern as
// RETENTION_REGISTRY_KEY). Unset in production ⇒ 'access-windows'.
const NS = process.env.ACCESS_WINDOWS_NS || 'access-windows';
const INDEX_KEY = `${NS}-index`;

const groupKeyId = (contractId: string, groupId: string) => sha256Hex(`${NS}:${contractId}:${groupId}`);
const cacheKey = (contractId: string, groupId: string) => `${contractId}\u0000${groupId}`;

// ── Types (S1.4's Zod schemas mirror the inputs) ──

export interface WindowEntry {
  expires_at_ms: number;
  set_at_ms: number;
}

interface GroupWindows {
  contract_id: string;
  group_id: string;
  entries: Record<string, WindowEntry>;
}

interface IndexRef {
  contract_id: string;
  group_id: string;
}

export interface SetAccessWindowInput {
  group_id: string;
  member_id: string;
  access_minutes: number;
  contract_id?: string;
}

export interface AccessWindowRefInput {
  group_id: string;
  member_id: string;
  contract_id?: string;
}

export interface DueWindow {
  contract_id: string;
  group_id: string;
  member_id: string;
  expires_at_ms: number;
}

// ── Lock: a promise chain. Every public op runs inside it. ──

let tail: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

// ── Cache (authoritative once loaded; see header) ──

let indexCache: IndexRef[] | null = null;
const groupCache = new Map<string, GroupWindows>();

/** Exposed for the harness only: simulates a process restart (forces reload from KV). */
export function _resetAccessWindowCache(): void {
  indexCache = null;
  groupCache.clear();
}

function corrupt(what: string): ApiError {
  return new ApiError(500, 'ACCESS_WINDOWS_CORRUPT', `Access-window ${what} is unreadable`);
}

function decodeJson(blob: string | number[]): unknown {
  return JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
}

async function loadIndex(): Promise<IndexRef[]> {
  if (indexCache) return indexCache;
  const blob = await getBlobFromKVStrict(INDEX_KEY); // throws on RPC error
  if (!blob) {
    indexCache = [];
    return indexCache;
  }
  const parsed = decodeJson(blob);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((r) => r && typeof r.contract_id === 'string' && typeof r.group_id === 'string')
  ) {
    throw corrupt('index');
  }
  indexCache = parsed as IndexRef[];
  return indexCache;
}

async function loadGroup(contractId: string, groupId: string): Promise<GroupWindows> {
  const k = cacheKey(contractId, groupId);
  const cached = groupCache.get(k);
  if (cached ) return cached; // MUTATION (S1.6): delete this line → reads hit KV 'final', which lags writes
  const blob = await getBlobFromKVStrict(groupKeyId(contractId, groupId)); // throws on RPC error
  let gw: GroupWindows;
  if (!blob) {
    gw = { contract_id: contractId, group_id: groupId, entries: {} };
  } else {
    const parsed = decodeJson(blob) as GroupWindows;
    if (
      !parsed || typeof parsed.entries !== 'object' || parsed.entries === null ||
      parsed.contract_id !== contractId || parsed.group_id !== groupId
    ) {
      throw corrupt(`list for group ${groupId}`);
    }
    gw = parsed;
  }
  groupCache.set(k, gw);
  return gw;
}

// Write-through: KV first, cache only after the write commits.
async function writeGroup(gw: GroupWindows): Promise<void> {
  await storeBlobToKV(
    groupKeyId(gw.contract_id, gw.group_id),
    encryptBlob(Buffer.from(JSON.stringify(gw), 'utf8')),
  );
  groupCache.set(cacheKey(gw.contract_id, gw.group_id), gw);
}

async function writeIndex(next: IndexRef[]): Promise<void> {
  await storeBlobToKV(INDEX_KEY, encryptBlob(Buffer.from(JSON.stringify(next), 'utf8')));
  indexCache = next;
}

// Remove one member's entry; drop the group from the index once it is empty
// (AFTER the empty blob is written — keeps index ⊇ live windows). Caller holds the lock.
async function removeMember(gw: GroupWindows, memberId: string): Promise<void> {
  const { [memberId]: _gone, ...rest } = gw.entries;
  await writeGroup({ ...gw, entries: rest });
  if (Object.keys(rest).length === 0) {
    const index = await loadIndex();
    const next = index.filter((r) => !(r.contract_id === gw.contract_id && r.group_id === gw.group_id));
    if (next.length !== index.length) await writeIndex(next);
  }
}

// ────────────────────────────────────────────────
// SET — called by MCP BEFORE the on-chain add. Upsert: replaces any prior window.
// Throws if the KV write fails, so MCP aborts the add (no unrecorded window).
// ────────────────────────────────────────────────

export async function setAccessWindow(input: SetAccessWindowInput) {
  const { group_id, member_id, access_minutes, contract_id } = input;
  const { contractId } = resolveContract(contract_id, group_id);

  return withLock(async () => {
    const index = await loadIndex();
    const gw = await loadGroup(contractId, group_id);

    // Index FIRST (superset invariant).
    if (!index.some((r) => r.contract_id === contractId && r.group_id === group_id)) {
      await writeIndex([...index, { contract_id: contractId, group_id }]);
    }

    const now = Date.now();
    const entry: WindowEntry = { expires_at_ms: now + access_minutes * 60_000, set_at_ms: now };
    await writeGroup({ ...gw, entries: { ...gw.entries, [member_id]: entry } });

    const expires_at = new Date(entry.expires_at_ms).toISOString();
    log('info', 'access_window_set', {
      group_id, member_hash: hashForLog(member_id), access_minutes, expires_at,
    });
    return {
      set: true,
      group_id,
      member_id,
      contract_id: contractId,
      expires_at,
      expires_at_ms: entry.expires_at_ms,
    };
  });
}

// ────────────────────────────────────────────────
// CLEAR — called by MCP on EVERY add without a window (so a re-add never
// inherits an old expiry) and best-effort on an early revoke. Idempotent.
// ────────────────────────────────────────────────

export async function clearAccessWindow(input: AccessWindowRefInput) {
  const { group_id, member_id, contract_id } = input;
  const { contractId } = resolveContract(contract_id, group_id);

  return withLock(async () => {
    const gw = await loadGroup(contractId, group_id);
    if (!gw.entries[member_id]) {
      return { cleared: true, was_present: false };
    }
    await removeMember(gw, member_id);
    log('info', 'access_window_cleared', { group_id, member_hash: hashForLog(member_id) });
    return { cleared: true, was_present: true };
  });
}

// ────────────────────────────────────────────────
// GET — one member's window, or null. (MCP gates this to the group owner.)
// ────────────────────────────────────────────────

export async function getAccessWindow(input: AccessWindowRefInput) {
  const { group_id, member_id, contract_id } = input;
  const { contractId } = resolveContract(contract_id, group_id);

  return withLock(async () => {
    const gw = await loadGroup(contractId, group_id);
    const e = gw.entries[member_id];
    return {
      group_id,
      member_id,
      contract_id: contractId,
      window: e
        ? {
            expires_at: new Date(e.expires_at_ms).toISOString(),
            expires_at_ms: e.expires_at_ms,
            set_at: new Date(e.set_at_ms).toISOString(),
          }
        : null,
    };
  });
}

// ────────────────────────────────────────────────
// SWEEP SUPPORT (S3, internal — no route)
// ────────────────────────────────────────────────

/** Every entry with expires_at_ms <= nowMs. A group that fails to load is reported, never skipped silently. */
export async function listDueWindows(nowMs: number = Date.now()) {
  return withLock(async () => {
    const index = await loadIndex();
    const due: DueWindow[] = [];
    const errors: Array<{ contract_id: string; group_id: string; error: string }> = [];

    for (const ref of index) {
      try {
        const gw = await loadGroup(ref.contract_id, ref.group_id);
        for (const [member_id, e] of Object.entries(gw.entries)) {
          if (e.expires_at_ms <= nowMs) {
            due.push({ contract_id: ref.contract_id, group_id: ref.group_id, member_id, expires_at_ms: e.expires_at_ms });
          }
        }
      } catch (err) {
        errors.push({ contract_id: ref.contract_id, group_id: ref.group_id, error: (err as Error).message });
      }
    }
    return { groups: index.length, due, errors };
  });
}

/**
 * Remove an entry AFTER the sweep revoked + rotated — but ONLY if it is still the
 * same window the sweep acted on. If the member was re-added with a new window
 * mid-sweep, expires_at_ms differs and the new window survives.
 * contractId is already resolved (it comes from listDueWindows).
 */
export async function completeAccessWindow(w: DueWindow) {
  return withLock(async () => {
    const gw = await loadGroup(w.contract_id, w.group_id);
    const e = gw.entries[w.member_id];
    if (!e) return { removed: false, reason: 'absent' as const };
    if (e.expires_at_ms !== w.expires_at_ms) return { removed: false, reason: 'replaced' as const };
    await removeMember(gw, w.member_id);
    log('info', 'access_window_completed', { group_id: w.group_id, member_hash: hashForLog(w.member_id) });
    return { removed: true as const };
  });
}
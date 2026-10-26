// shade-agent/src/lib/services/scheduler.ts
//
// §6.1 Piece 4 — S3: the IN-PROCESS SCHEDULER. Two jobs, one ticker.
//
//   (a) WINDOW SWEEP (every tick, ~60s): revoke members whose access window has
//       expired, signed as the custodial GROUP OWNER (S2 signAsOwner), then
//       rotate the group key forward, then drop the window entry.
//   (b) DAILY RETENTION (first tick of each UTC day, i.e. the 00:00 run; also on
//       boot if the last completed day is before today — the catch-up): scan the
//       retention registry (free views) and execute (confirm:true) every group
//       with expired files, signed as nova-sdk.near.
//
// PURE BY DESIGN: this module imports nothing that touches KV, keys or the chain.
// Every effect is an injected dependency (SchedulerDeps), so the S3 harness drives
// ticks with a FAKE CLOCK and fakes, offline and deterministically. The live
// wiring is scheduler-live.ts (S3.3).
//
// ─── Window sweep, per due entry (idempotent; a crash anywhere just reruns) ───
//   1. is_authorized(group, member)?
//        yes → owner = get_group_owner(group) → revoke AS OWNER
//              ("User not a member" panic ⇒ already gone ⇒ treated as done)
//        no  → skip the revoke (early revoke, or a crash after a previous revoke)
//   2. rotate the group key — ALWAYS. A crash between revoke and rotate is the
//      reason: the rerun sees is_authorized=false and must still rotate.
//      (An extra rotation after an early revoke only bumps the version: harmless.)
//      GROUP_NOT_FOUND ⇒ treated as done (nothing left to protect).
//   3. completeAccessWindow — removes the entry ONLY if it is still the same
//      window (a re-add mid-sweep survives; S1.3).
//
//   Failures are counted IN MEMORY (reset on restart):
//     • permanent (OWNER_NOT_CUSTODIAL / OWNER_KEY_NOT_FOUND / group without an
//       owner) ⇒ STUCK at once — retrying can never succeed.
//     • anything else ⇒ retried every tick; STUCK after MAX_ATTEMPTS.
//   STUCK entries stay in the list (never silently dropped), are reported by
//   getStatus(), and are skipped until a restart resets the counters.
//
// ─── Daily retention ───
//   Marker (KV, via deps): the last UTC date whose run FULLY succeeded. Written
//   only when every group with expired files was destroyed cleanly. Otherwise the
//   failed groups (only those — completed ones are remembered for the day) are
//   retried every RETENTION_RETRY_MS. Each retry costs gas, hence not every tick.
//   A malformed file location is PERMANENT: logged as an error, not retried, and
//   does not block the day. After a restart the day's groups rerun — safe:
//   shredding a shredded key is a no-op and the contract keeps the first tombstone.
//
// Overlap: each job has its own running flag; a tick that finds its job still
// running is skipped (never queued).
//
// Kill switch: start() is a no-op unless options.enabled is true. The wiring
// passes SCHEDULER_ENABLED === 'true' exactly; anything else is OFF.
import { log } from '../logger.js';
import { hashForLog } from '../crypto.js';
export const TICK_MS = 60_000;
export const MAX_ATTEMPTS = 10;
export const RETENTION_RETRY_MS = 15 * 60_000;
export const OVERDUE_REPORT_MS = 5 * 60_000;
const PERMANENT_CODES = new Set(['OWNER_NOT_CUSTODIAL', 'OWNER_KEY_NOT_FOUND']);
function errCode(e) {
    const c = e?.code;
    return typeof c === 'string' ? c : undefined;
}
function errMsg(e) {
    return e instanceof Error ? e.message : String(e);
}
function isNotAMember(e) {
    return /not a member/i.test(errMsg(e));
}
function windowKey(w) {
    return `${w.contract_id}|${w.group_id}|${w.member_id}|${w.expires_at_ms}`;
}
/** UTC calendar date of a timestamp, 'YYYY-MM-DD'. */
export function utcDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}
class PermanentError extends Error {
    code = 'PERMANENT';
}
export function createScheduler(deps, options) {
    const tickMs = options.tickMs ?? TICK_MS;
    let timer = null;
    let startedAt = null;
    let initialized = false;
    // window sweep state
    let sweepRunning = false;
    const failures = new Map();
    const sweepStatus = {
        last_run_at: null,
        last_duration_ms: null,
        last_due: 0,
        last_done: 0,
        last_failed: 0,
        last_skipped_stuck: 0,
        list_errors: [],
        overdue: [],
    };
    // daily retention state
    let retentionRunning = false;
    let markerDate; // undefined ⇒ not read yet
    let dayInProgress = null;
    let completedToday = new Set();
    let lastRetentionAttemptMs = null;
    const retentionStatus = {
        last_attempt_at: null,
        last_outcome: null,
        last_failed_groups: [],
        last_destroyed: 0,
    };
    async function ensureInit() {
        if (initialized)
            return true;
        try {
            await deps.init();
            initialized = true;
            log('info', 'scheduler_initialized', {});
            return true;
        }
        catch (e) {
            log('warn', 'scheduler_init_failed', { error: errMsg(e) });
            return false;
        }
    }
    // ── (a) window sweep ──────────────────────────────────────────────────────
    async function processWindow(w, nowMs) {
        const key = windowKey(w);
        const member_hash = hashForLog(w.member_id);
        try {
            const wasMember = await deps.isMember(w);
            if (wasMember) {
                const owner = await deps.groupOwner(w);
                if (!owner)
                    throw new PermanentError('group has no owner');
                try {
                    await deps.revokeAsOwner(owner, w);
                }
                catch (e) {
                    if (!isNotAMember(e))
                        throw e; // already gone (race with an early revoke) ⇒ fine
                }
            }
            try {
                await deps.rotateKey(w);
            }
            catch (e) {
                if (errCode(e) !== 'GROUP_NOT_FOUND')
                    throw e;
            }
            await deps.completeWindow(w);
            failures.delete(key);
            log('info', 'window_revoked', {
                group_id: w.group_id, member_hash, was_member: wasMember,
                overdue_ms: Math.max(0, nowMs - w.expires_at_ms),
            });
            return 'done';
        }
        catch (e) {
            const prev = failures.get(key);
            const rec = {
                window: w,
                attempts: (prev?.attempts ?? 0) + 1,
                stuck: prev?.stuck ?? false,
                last_error: errMsg(e),
                last_attempt_at: new Date(nowMs).toISOString(),
            };
            const permanent = e instanceof PermanentError || PERMANENT_CODES.has(errCode(e) ?? '');
            if (permanent || rec.attempts >= MAX_ATTEMPTS)
                rec.stuck = true;
            failures.set(key, rec);
            log(rec.stuck ? 'error' : 'warn', rec.stuck ? 'window_stuck' : 'window_revoke_failed', {
                group_id: w.group_id, member_hash, attempts: rec.attempts, permanent, error: rec.last_error,
            });
            return 'failed';
        }
    }
    async function tickSweep() {
        if (sweepRunning)
            return 'skipped_overlap';
        if (!(await ensureInit()))
            return 'skipped_not_initialized';
        sweepRunning = true;
        const t0 = deps.now();
        try {
            let listed;
            try {
                listed = await deps.listDueWindows(t0);
            }
            catch (e) {
                log('warn', 'window_sweep_list_failed', { error: errMsg(e) });
                return 'list_failed';
            }
            let done = 0, failed = 0, skippedStuck = 0;
            for (const w of listed.due) {
                if (failures.get(windowKey(w))?.stuck) {
                    skippedStuck++;
                    continue;
                }
                (await processWindow(w, t0)) === 'done' ? done++ : failed++;
            }
            Object.assign(sweepStatus, {
                last_run_at: new Date(t0).toISOString(),
                last_duration_ms: deps.now() - t0,
                last_due: listed.due.length,
                last_done: done,
                last_failed: failed,
                last_skipped_stuck: skippedStuck,
                list_errors: listed.errors,
                overdue: listed.due
                    .filter((w) => t0 - w.expires_at_ms > OVERDUE_REPORT_MS)
                    .filter((w) => failures.has(windowKey(w)))
                    .map((w) => ({ group_id: w.group_id, member_hash: hashForLog(w.member_id), overdue_ms: t0 - w.expires_at_ms })),
            });
            if (listed.errors.length) {
                log('warn', 'window_sweep_group_errors', { count: listed.errors.length });
            }
            return 'ran';
        }
        finally {
            sweepRunning = false;
        }
    }
    // ── (b) daily retention ───────────────────────────────────────────────────
    async function tickRetention() {
        if (retentionRunning)
            return 'skipped_overlap';
        if (!(await ensureInit()))
            return 'skipped_not_initialized';
        const nowMs = deps.now();
        const today = utcDate(nowMs);
        if (markerDate === undefined) {
            try {
                markerDate = await deps.readRetentionMarker();
            }
            catch (e) {
                log('warn', 'retention_marker_read_failed', { error: errMsg(e) });
                return 'marker_read_failed';
            }
        }
        if (markerDate === today)
            return 'already_done';
        if (dayInProgress !== today) {
            dayInProgress = today;
            completedToday = new Set();
            lastRetentionAttemptMs = null;
        }
        if (lastRetentionAttemptMs !== null && nowMs - lastRetentionAttemptMs < RETENTION_RETRY_MS) {
            return 'waiting_retry';
        }
        retentionRunning = true;
        lastRetentionAttemptMs = nowMs;
        retentionStatus.last_attempt_at = new Date(nowMs).toISOString();
        let outcome;
        try {
            const scan = await deps.scanRetention(); // throws on registry read failure
            const failedGroups = [];
            let destroyed = 0;
            for (const g of scan.groups) {
                if (completedToday.has(g.group_id))
                    continue;
                if (g.error) {
                    failedGroups.push(g.group_id);
                    continue;
                } // view failed: unknown, retry
                if (g.retention_days === null || g.expired_trans_ids.length === 0) { // nothing to do
                    completedToday.add(g.group_id);
                    continue;
                }
                try {
                    const r = await deps.executeRetention(g.group_id);
                    destroyed += r.destroyed_count;
                    const permanent = r.results.filter((x) => !x.destroyed && /^bad location/.test(x.error ?? ''));
                    const retryable = r.results.filter((x) => x.bookkeeping_incomplete || (!x.destroyed && !/^bad location/.test(x.error ?? '')));
                    if (permanent.length) {
                        log('error', 'retention_daily_unparseable_files', { group_id: g.group_id, count: permanent.length });
                    }
                    if (retryable.length)
                        failedGroups.push(g.group_id);
                    else
                        completedToday.add(g.group_id);
                }
                catch (e) {
                    log('warn', 'retention_daily_group_failed', { group_id: g.group_id, error: errMsg(e) });
                    failedGroups.push(g.group_id);
                }
            }
            retentionStatus.last_failed_groups = failedGroups;
            retentionStatus.last_destroyed = destroyed;
            if (failedGroups.length === 0) {
                await deps.writeRetentionMarker(today); // throws ⇒ caught below ⇒ retried in 15 min
                markerDate = today;
                outcome = 'done';
                log('info', 'retention_daily_done', { date: today, destroyed, groups: scan.groups.length });
            }
            else {
                outcome = 'partial';
                log('warn', 'retention_daily_partial', { date: today, destroyed, failed_groups: failedGroups.length });
            }
        }
        catch (e) {
            outcome = 'failed';
            log('error', 'retention_daily_failed', { date: today, error: errMsg(e) });
        }
        finally {
            retentionRunning = false;
        }
        retentionStatus.last_outcome = outcome;
        return outcome;
    }
    // ── lifecycle + status ────────────────────────────────────────────────────
    function tick() {
        void tickSweep().catch((e) => log('error', 'window_sweep_crashed', { error: errMsg(e) }));
        void tickRetention().catch((e) => log('error', 'retention_daily_crashed', { error: errMsg(e) }));
    }
    function start() {
        if (!options.enabled) {
            log('info', 'scheduler_disabled', {});
            return false;
        }
        if (timer)
            return true;
        startedAt = new Date(deps.now()).toISOString();
        log('info', 'scheduler_started', { tick_ms: tickMs });
        tick();
        timer = setInterval(tick, tickMs);
        return true;
    }
    function stop() {
        if (timer)
            clearInterval(timer);
        timer = null;
    }
    function getStatus() {
        return {
            enabled: options.enabled,
            running: timer !== null,
            started_at: startedAt,
            initialized,
            window_sweep: { running: sweepRunning, ...sweepStatus },
            retention_daily: {
                running: retentionRunning,
                marker_date: markerDate ?? null,
                day_in_progress: dayInProgress,
                completed_groups_today: completedToday.size,
                ...retentionStatus,
            },
            failures: [...failures.values()].map((f) => ({
                group_id: f.window.group_id,
                member_hash: hashForLog(f.window.member_id),
                expires_at: new Date(f.window.expires_at_ms).toISOString(),
                attempts: f.attempts,
                stuck: f.stuck,
                last_error: f.last_error,
                last_attempt_at: f.last_attempt_at,
            })),
        };
    }
    return { start, stop, tickSweep, tickRetention, getStatus };
}

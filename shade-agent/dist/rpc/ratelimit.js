// nova/shade-agent/src/rpc/ratelimit.ts
//
// 7.4 — minimal in-memory rate limiter for the /rpc/user-keys/store procedure.
//
// WHY THIS EXISTS: the deleted Hono /store route rate-limited by x-forwarded-for.
// The surviving /rpc surface had no equivalent (roadmap step 6.4 carry). This
// restores a safeguard on the write path — /store does TWO KV writes (a signed
// on-chain tx each) per call, so a retry storm or a looping internal caller is
// expensive. It is NOT closing a live hole: /store's only callers are the two
// gated services (frontend signup, MCP), already behind X-Internal-Auth.
//
// SCOPE (deliberately minimal, per roadmap "don't over-build a low-exposure gap"):
//   - AGGREGATE, not per-account. Verified identity isn't available at the
//     middleware layer (it's established inside storeUserKey, after Auth0
//     verification). Keying on the UNVERIFIED body account_id would trust an
//     assertion — the exact anti-pattern v0.4 closed. Per-account fairness is
//     deferred to v0.5's auth rework, where the single verified boundary makes
//     identity available before the service runs (§5.0).
//   - store-ONLY. Applied via a `pub.use(...)` builder variant in base.ts; the
//     other eight procedures are untouched.
//   - INSIDE the gate. Because it composes onto `pub` (which runs
//     requireInternalAuth first), a request rejected at the gate never reaches
//     — or consumes — the limiter. The "gate outermost" invariant holds.
//
// ALGORITHM: sliding-window log. We keep the timestamps of recent calls and,
// on each call, drop those older than the window, then check the count. Same
// in-memory, time-keyed, self-expiring shape as MCP's PENDING_UPLOADS. On a
// single CVM, in-memory state is correct (no multi-instance to coordinate).
import { os, ORPCError } from '@orpc/server';
import { log } from '../lib/logger.js';
// ────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────
//
// 30 calls / 60s, aggregate across ALL /store callers. Legitimate load is a
// human signup (one store) or MCP storing a key (one store) — nowhere near this.
// A retry storm or a loop trips it. Adjust here if real traffic ever approaches.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
// Aggregate limiter → one bucket. (A Map keyed by a constant keeps the shape
// ready if a future key function is ever wanted, without restructuring.)
const RATE_KEY = 'store';
const hits = new Map();
/**
 * Record a call under `key` and return whether it is within the limit.
 * Prunes timestamps older than the window on every call, so the map cannot
 * grow unbounded for an active key.
 */
function underLimit(key, now) {
    const cutoff = now - WINDOW_MS;
    const recent = (hits.get(key) ?? []).filter(ts => ts > cutoff);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= MAX_REQUESTS;
}
// ────────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────────
//
// Throws ORPCError directly (adapter-native), NOT ApiError. base.ts's mapErrors
// passes an already-ORPCError through untouched (`if (err instanceof ORPCError)
// throw err`), so this does not depend on the ApiError→ORPCError conversion path.
// mount.ts's customErrorResponseBodyEncoder then renders it as our { error, code }
// wire format — the same path every other error takes. The status/code/message
// map exactly to that encoder's output: { error: message, code: 'TOO_MANY_REQUESTS' }.
const base = os.$context();
export const rateLimitStore = base.middleware(async ({ next }) => {
    const now = Date.now();
    if (!underLimit(RATE_KEY, now)) {
        log('warn', 'store_rate_limited', { window_ms: WINDOW_MS, max: MAX_REQUESTS });
        throw new ORPCError('TOO_MANY_REQUESTS', {
            status: 429,
            message: 'Rate limit exceeded for store; retry shortly',
        });
    }
    return next();
});

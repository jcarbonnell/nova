# Observability, Resilience & Cleanup

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 for the API structure. Production hardening — structured logging, graceful degradation, circuit breaker, input validation, and removing dangerous patterns from shade-agent. Ongoing work that applies across all other tickets.

### Overview
Replace all `console.log` with structured logging, implement a circuit breaker for NEAR RPC calls, add graceful startup with health endpoints, apply input validation everywhere, and clean up debug stubs and dangerous patterns inherited from shade-agent.

### Acceptance Criteria

**Structured Logging (`api/src/lib/logger.ts`):**
- [ ] Structured JSON log helper: `log.info(event, data)`, `log.error(event, data)`, `log.warn(event, data)`
- [ ] Output to stdout as JSON lines (machine-readable)
- [ ] Never log PII: no emails, no full account IDs (use first 8 chars + hash), no private keys, no raw tokens, no wallet IDs
- [ ] Log event names: `auth_success`, `auth_failure`, `key_retrieved`, `key_rotation`, `file_upload`, `file_retrieve`, `rpc_failure`, `db_error`, `cache_hit`, `cache_miss`
- [ ] Include `timestamp`, `level`, `event`, and `data` fields in each log line
- [ ] Replace all `console.log` calls in `api/src/` with structured logger
- [ ] Log on: auth attempts, key retrievals, key rotations, file operations, RPC calls (masked URL), DB queries (slow queries only, > 100ms), errors

**Graceful Startup:**
- [ ] Server starts HTTP listener immediately — no blocking `while(true)` loop
- [ ] Health endpoint `GET /ping` returns:
  - `{ status: "healthy" | "degraded", masterSeedReady: boolean, dbReady: boolean, uptime: seconds }`
  - `degraded` during initialization (master seed not yet loaded, DB not yet connected)
  - `healthy` when all services ready
- [ ] Registration/initialization runs in background (non-blocking)
- [ ] Master seed initialization as part of `initialize` Effect lifecycle — not in a startup loop

**Circuit Breaker (`api/src/lib/rpc-gate.ts`):**
- [ ] Wrap all NEAR RPC calls with a circuit breaker per target-architecture.md §7.2
- [ ] States: `CLOSED` (normal) → after N failures in time window → `OPEN` → after timeout → `HALF_OPEN`
- [ ] In `OPEN` state: return cached data if available, or error immediately with `503 Service Unavailable`
- [ ] In `HALF_OPEN` state: allow one probe request; on success → `CLOSED`, on failure → `OPEN`
- [ ] Configurable thresholds: `failureThreshold` (default 5), `resetTimeout` (default 30s), `windowDuration` (default 60s)
- [ ] Circuit breaker per RPC endpoint (or per contract)
- [ ] Log state transitions

**Graceful Degradation:**
- [ ] NEAR RPC unreachable → return cached KV/DB reads, reject writes with `retry-after` header
- [ ] Database unreachable → immediate error, no retry loops
- [ ] Rate limiter full → `429 Too Many Requests` with retry-after header
- [ ] Circuit open → `503 Service Unavailable` with retry-after header

**Input Validation:**
- [ ] All endpoints validate request bodies with Zod schemas before processing
- [ ] Size limits: `uploadFile` max 50MB, all other requests max 1MB
- [ ] Account ID format: `^[a-z0-9._-]+\.(near|testnet)$`
- [ ] Group ID format: alphanumeric + `_` `-`, 1-64 chars
- [ ] `.safeParse()` pattern for all inputs — return `400` with `flatten()` errors if invalid

**Rate Limiting:**
- [ ] Apply rate limiting to all mutation endpoints (not just `/user-keys/store`):
  - `/generateApiKey`: 5 req/min
  - `/uploadFile`: 20 req/min
  - `/verifyAuthChallenge`: 10 req/min
  - All others: 30 req/min
- [ ] Simple in-memory Map-based limiter (fine for single-process)
- [ ] Return `429 Too Many Requests` with `X-RateLimit-Reset` header

**Cleanup — Remove Dangerous/Debug Patterns:**
- [ ] Remove the `MASTER_SEED_INIT_ALLOWED` silent overwrite path entirely
- [ ] Remove the attestation stub (`verified: false`)
- [ ] Remove the debug groups endpoint with hardcoded data
- [ ] Remove the backwards network-switch logic (testnet ↔ mainnet link)
- [ ] Remove `{ ignoreBuildErrors: true }` equivalent in nova-sdk.com build config
- [ ] Remove any `Cache-Control: no-store` on static assets (should be properly handled by everything-dev host)

**Unified Error Handling:**
- [ ] Consistent `ApiError` class used across all services
- [ ] Error handler middleware in oRPC: catch unhandled errors → `500 { error: { code: 'INTERNAL', message: 'Internal server error' } }`
- [ ] Never expose stack traces or internal details in error responses
- [ ] Map known errors: `NotFoundError` → 404, `UnauthorizedError` → 401, `ForbiddenError` → 403, `ValidationError` → 400

**Parallel RPC Calls:**
- [ ] Where two RPC calls are independent (e.g., fetch access key + fetch block hash), run them in `Promise.all()` per target-architecture.md §5.5
- [ ] NEAR kit may already provide batching — preference over manual parallelization

### Notes
- [ ] Structured logging is critical — without it, production debugging is flying blind
- [ ] The circuit breaker prevents cascading failures when NEAR RPC is degraded
- [ ] Do not introduce new dependencies for logging — a simple function that writes JSON to stdout is sufficient and standard in containerized apps
- [ ] Health endpoint must work even when NEAR RPC is down (it checks local state, not remote)
- [ ] Apply rate limiting in oRPC middleware, not in individual route handlers

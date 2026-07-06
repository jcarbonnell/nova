# API Contract, Crypto, Logging & Core Utilities

### Context
This is a child ticket of #001-rebuild-nova, blocking #002, #003, #004, #005, #006, to define the full oRPC API surface, implement the core cryptographic layer, structured logging, and startup lifecycle. All other tickets depend on this contract being stable and the crypto utilities being available.

### Overview
Define the NOVA oRPC contract in `api/src/contract.ts` and implement core crypto in `api/src/lib/crypto.ts`. Implement the master seed lifecycle with graceful startup. Add structured logging. In this proposal, auth is handled by better-near-auth (NEAR SIWN, session management, API keys, permission scoping) — no custom auth routes or API key derivation needed.

### Acceptance Criteria

**Contract Definition (`api/src/contract.ts`):**
- [ ] Define all oRPC routes using `oc.router()` and `oc.route()`:
  - `ping` — health check returning status + master seed state
  - `storeUserKey` — store encrypted user key material (auth required)
  - `retrieveUserKey` — retrieve and decrypt user key (auth required)
  - `checkUserExists` — check if account has stored keys (public)
  - `generateGroupKey` — derive and store group key v1, call contract `register_group` (auth required)
  - `getGroupKey` — retrieve group key for group (auth required, member check via contract `is_authorized`)
  - `getOwnedGroups` — list groups owned by caller via contract `get_owned_groups` (auth required)
  - `getMemberGroups` — list groups where caller is a member via contract `get_member_groups` (auth required)
  - `getGroupMembers` — list members via contract `get_group_members` (auth required, member check)
  - `revokeGroupMember` — remove member via contract `revoke_group_member` + trigger key rotation + re-wrap (owner auth required)
  - `rotateGroupKey` — manual key rotation, update contract `update_checksum` (owner auth required)
  - `uploadFile` — store encrypted file + wrapped file key, call contract `record_transaction` (auth required, member check)
  - `retrieveFile` — get encrypted file + wrapped file key (auth required, member check)
  - `listFiles` — list files in a group via contract `get_transactions_for_group` (auth required, member check)
  - `getAuditLog` — query audit events from DB with filters (auth required)
  - `getAttestation` — return TEE attestation status (public, delegated to #001-07)
- [ ] Each route has typed Zod input/output schemas
- [ ] Auth-protected routes declare error types (`UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `FORBIDDEN`)
- [ ] Contract uses `every-plugin/orpc` imports and patterns
- [ ] Types inferred from the oRPC contract via `bos types gen`
- [ ] API key management is handled by better-near-auth — no contract routes needed for it

**Crypto Utilities (`api/src/lib/crypto.ts`):**
- [ ] `deriveKey(masterSeed: Uint8Array, salt: string, length: number): Uint8Array` — HKDF-SHA256 with info `"nova-v1"` per target-architecture.md §2
- [ ] `encryptBlob(plaintext: Uint8Array, key: Uint8Array): string` — AES-256-GCM (12-byte random IV, 16-byte auth tag) per target-architecture.md §3
  - Format: `base64(IV || ciphertext || auth_tag)`
  - Must reject invalid auth tags on decrypt (throw error)
- [ ] `decryptBlob(encrypted: string, key: Uint8Array): Uint8Array` — AES-256-GCM decryption with auth tag verification
  - Support both base64 string format and raw byte array input
- [ ] `generateMasterSeed(): Uint8Array` — crypto.randomBytes(32)
- [ ] All crypto uses `@noble/hashes` for HKDF and `node:crypto` for AES-256-GCM (no CBC mode)

**Master Seed Management:**
- [ ] On first deploy: generate random 32-byte master seed, store encrypted
- [ ] Encrypt master seed at rest using `BETTER_AUTH_SECRET` (or `TEE_KEY_SECRET` when deployed on Phala per #001-07)
- [ ] On startup: load and decrypt master seed from DB
- [ ] Add startup check: fail fast if master seed cannot be decrypted or is missing
- [ ] Remove the dangerous `MASTER_SEED_INIT_ALLOWED` silent overwrite path
- [ ] Implement DB migration for `master_seed` table: `id`, `encrypted_seed (text)`, `version (int)`, `created_at`

**Graceful Startup:**
- [ ] Server starts HTTP listener immediately — no blocking `while(true)` loop
- [ ] Health endpoint `GET /nova/ping` returns `{ status: "healthy" | "degraded", masterSeedReady: boolean, dbReady: boolean, uptime: seconds }`
- [ ] `degraded` during initialization (master seed not yet loaded, DB not yet connected)
- [ ] `healthy` when all services ready
- [ ] Registration/initialization runs as part of `initialize` Effect lifecycle — non-blocking

**Structured Logging (`api/src/lib/logger.ts`):**
- [ ] Structured JSON log helper: `log.info(event, data)`, `log.error(event, data)`, `log.warn(event, data)`
- [ ] Output to stdout as JSON lines (machine-readable)
- [ ] Never log PII: no emails, no full account IDs (use first 8 chars + hash), no private keys, no raw tokens, no wallet IDs
- [ ] Log event names: `auth_success`, `auth_failure`, `key_retrieved`, `key_rotation`, `file_upload`, `file_retrieve`, `rpc_failure`, `db_error`, `cache_hit`, `cache_miss`
- [ ] Include `timestamp`, `level`, `event`, and `data` fields in each log line
- [ ] Replace all `console.log` calls in `api/src/` with structured logger

**Unified Error Handling:**
- [ ] Consistent `ApiError` class with `statusCode`, `code`, `message`, `details`
- [ ] Consistent error format: `{ error: { code: string, message: string } }`
- [ ] All endpoints validate request bodies with Zod schemas before processing
- [ ] Use `ORPCError` from `every-plugin/orpc` in middleware for standardized framework errors
- [ ] Error handler middleware: catch unhandled errors → `500 { error: { code: 'INTERNAL', message: 'Internal server error' } }`
- [ ] Never expose stack traces or internal details in error responses
- [ ] Map known errors: `NotFoundError` → 404, `UnauthorizedError` → 401, `ForbiddenError` → 403, `ValidationError` → 400

**Auth Middleware (`api/src/lib/auth.ts`):**
- [ ] Extend existing `createAuthMiddleware` with group membership verification
- [ ] Group membership check: verify via NEAR contract `is_authorized(group_id, user_id)` (mirrored in DB for fast lookups)
- [ ] Ownership check: verify via contract `get_group_owner` — only owner can rotate keys, revoke members, delete groups
- [ ] Auth is provided by better-near-auth (SIWN, sessions, API keys with permission scoping) — no custom auth routes
- [ ] Session user is already in context from better-near-auth middleware

**Contract Method Mapping (appendix):**
- [ ] Document which NEAR contract method is called by each API route:

| API Route | NEAR Contract Method |
|---|---|
| `generateGroupKey` | `contract.register_group(group_id)` — creates group, emits `Registered` |
| `getOwnedGroups` | `contract.get_owned_groups()` — caller's owned groups |
| `getMemberGroups` | `contract.get_member_groups()` — caller's member groups |
| `getGroupMembers` | `contract.get_group_members(group_id)` — list members |
| `revokeGroupMember` | `contract.revoke_group_member(group_id, user_id)` — emits `Revoked` |
| `rotateGroupKey` | `contract.update_checksum(group_id, checksum)` — update after rotation |
| Membership check | `contract.is_authorized(group_id, user_id)` — boolean |
| Ownership check | `contract.get_group_owner(group_id)` — owner AccountId |
| `uploadFile` | `contract.record_transaction(group_id, user_id, file_hash, storage_ref)` — audit trail |
| `listFiles` | `contract.get_transactions_for_group(group_id)` — file history |

### Notes
- [ ] Use `every-plugin/effect` for master seed initialization in the `initialize` lifecycle hook
- [ ] Use `@noble/hashes/hkdf` and `@noble/hashes/sha256` (already in the project)
- [ ] Do NOT use `crypto.createCipheriv('aes-256-cbc', ...)` — only GCM mode
- [ ] Do NOT implement API key derivation — better-near-auth handles API key generation, hashing, and verification
- [ ] Do NOT hardcode any URLs or contract IDs — read from bos.config.json variables or env vars
- [ ] Follow the existing `createPlugin` pattern from `api/src/index.ts` (the upvote plugin)
- [ ] Do not introduce new dependencies for logging — a function that writes JSON to stdout is sufficient

# Implement NOVA API Contract & Crypto Foundation

### Context
This is a child ticket of #001-rebuild-nova, blocking #002, #003, #004, #005, to define the full oRPC API surface and implement the core cryptographic layer. All other tickets depend on this contract being stable and the crypto utilities being available.

### Overview
Define the NOVA oRPC contract in `api/src/contract.ts` and implement core crypto in `api/src/lib/crypto.ts`. Implement the master seed lifecycle. Auth is handled by better-near-auth (NEAR SIWN, session management, API keys) — no custom challenge-response or auth routes needed. These are the foundation that every other API ticket builds on.

### Acceptance Criteria

**Contract Definition (`api/src/contract.ts`):**
- [ ] Define all oRPC routes using `oc.router()` and `oc.route()`:
  - `ping` — health check
  - `getMasterSeedStatus` — whether master seed is initialized
  - `storeUserKey` — store encrypted user key material (auth required)
  - `retrieveUserKey` — retrieve and decrypt user key (auth required)
  - `checkUserExists` — check if account has stored keys (public)
  - `generateApiKey` — generate versioned API key (auth required)
  - `verifyApiKey` — verify API key hash (public)
  - `hasApiKey` — check if API key exists (auth required)
  - `generateGroupKey` — derive and store group key v1 (auth required)
  - `getGroupKey` — retrieve group key for group (auth required, member check)
  - `revokeGroupMember` — remove member + trigger key rotation + re-wrap (owner auth required)
  - `rotateGroupKey` — manual key rotation (owner auth required)
  - `uploadFile` — store encrypted file + wrapped file key (auth required, member check)
  - `retrieveFile` — get encrypted file + wrapped file key (auth required, member check)
  - `listFiles` — list files in a group (auth required, member check)
  - `getAuditLog` — query audit events with filters (auth required)
- [ ] Each route has typed Zod input/output schemas
- [ ] Auth-protected routes declare error types (`UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `FORBIDDEN`)
- [ ] Contract uses `every-plugin/orpc` imports and patterns
- [ ] Types should not be re-instated — infer them from the oRPC contract via `bos types gen`

**Crypto Utilities (`api/src/lib/crypto.ts`):**
- [ ] `deriveKey(masterSeed: Uint8Array, salt: string, length: number): Uint8Array` — HKDF-SHA256 with info `"nova-v1"` per target-architecture.md §2
- [ ] `encryptBlob(plaintext: Uint8Array, key: Uint8Array): string` — AES-256-GCM (12-byte random IV, 16-byte auth tag) per target-architecture.md §3
  - Format: `base64(IV || ciphertext || auth_tag)` or raw byte array
  - Must reject invalid auth tags on decrypt (throw error)
- [ ] `decryptBlob(encrypted: string, key: Uint8Array): Uint8Array` — AES-256-GCM decryption with auth tag verification
  - Support both base64 string format and raw byte array input
- [ ] `generateMasterSeed(): Uint8Array` — crypto.randomBytes(32)
- [ ] All crypto uses `@noble/hashes` for HKDF and `node:crypto` for AES-256-GCM (no CBC mode)
- [ ] Remove the old `deriveKey`, `encryptBlob`, `decryptBlob` patterns from shade-agent (duplicated across files, CBC mode)

**Master Seed Management:**
- [ ] On first deploy: generate random 32-byte master seed, store encrypted in PostgreSQL (not NEAR KV)
- [ ] Encrypt master seed at rest using `BETTER_AUTH_SECRET` as encryption key (replaces TEE_KEY_SECRET)
- [ ] On startup: load and decrypt master seed from DB
- [ ] Add startup check: fail fast if master seed cannot be decrypted or is missing
- [ ] Remove the dangerous `MASTER_SEED_INIT_ALLOWED` silent overwrite path
- [ ] Add `GET /ping` endpoint that returns master seed status (`initialized: boolean`)
- [ ] Implement DB migration for `master_seed` table: `id`, `encrypted_seed (text)`, `version (int)`, `created_at`

**Auth Middleware (`api/src/lib/auth.ts`):**
- [ ] Extend existing `createAuthMiddleware` with group membership verification
- [ ] Group membership check: caller must be a member of the target group (source of truth: NEAR contract, mirrored in DB)
- [ ] Ownership check: only group owner can rotate keys, revoke members, delete groups
- [ ] API key auth: verify API key hash against DB, inject account_id into context
- [ ] No key material retrieval without verified session (better-near-auth handles session creation)
- [ ] Auth is provided by better-near-auth — no custom nonce/challenge/verify endpoints needed

**Error Handling:**
- [ ] Unified `ApiError` class with `statusCode`, `code`, `message`, `details`
- [ ] Consistent error format: `{ error: { code: string, message: string } }`
- [ ] All endpoints validate request bodies with Zod schemas before processing (reject oversized payloads)
- [ ] Use `ORPCError` from `every-plugin/orpc` in auth middleware for standardized framework errors as well as a domain-specific ApiError for internal services

### Notes
- [ ] Use `every-plugin/effect` for master seed initialization in the `initialize` lifecycle hook
- [ ] Use `@noble/hashes/hkdf` and `@noble/hashes/sha256` (already in the project due to `@noble/ed25519`)
- [ ] Do NOT use `crypto.createCipheriv('aes-256-cbc', ...)` — only GCM mode
- [ ] Do NOT store the master seed in NEAR KV — use PostgreSQL with `BETTER_AUTH_SECRET` encryption
- [ ] Do NOT hardcode any URLs or contract IDs — read from bos.config.json variables or env vars
- [ ] Follow the existing `createPlugin` pattern from `api/src/index.ts` (the upvote plugin)

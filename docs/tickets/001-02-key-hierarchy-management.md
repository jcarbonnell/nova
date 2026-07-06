# Implement Key Hierarchy & Management

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 for the contract and crypto utilities, to implement the three-tier key hierarchy and group management API. Blocked until the oRPC contract routes and crypto primitives are defined.

### Overview
Implement the key hierarchy from target-architecture.md §2: master seed → group key v{N} → file key. Build the key management service (`api/src/services/key-management.ts`) that handles group key generation, versioning, rotation on member revocation, re-wrapping, and user key storage/retrieval. Integrate with NEAR for on-chain group membership and transaction records.

### Acceptance Criteria

**Three-Tier Key Hierarchy:**
- [ ] Master seed → HKDF(`group:{groupId}:{network}:v{version}`) → GroupKey (32 bytes)
- [ ] GroupKey → HKDF(`file:{fileHash}`) → FileKey (32 bytes)
- [ ] All derivation uses `deriveKey()` from `api/src/lib/crypto.ts`
- [ ] Key versions are integers starting at 1, incremented on rotation
- [ ] Encrypted group keys stored in PostgreSQL under `group_id + version`

**Group Key Management (`api/src/services/key-management.ts`):**
- [ ] `generateGroupKey(groupId: string, ownerAccountId: string): Promise<{ groupId, version }>` — derive group key v1, encrypt, store in DB, register group on NEAR contract
- [ ] `getGroupKey(groupId: string, version?: number): Promise<Uint8Array>` — fetch encrypted group key from DB, decrypt, return (auth check: caller must be group member)
- [ ] `rotateGroupKey(groupId: string, triggeredBy: string, reason: string): Promise<{ groupId, oldVersion, newVersion, rewrappedCount }>` — derive v{N+1}, re-wrap all existing file keys, store new encrypted group key, emit audit event
- [ ] `revokeMember(groupId: string, memberId: string, triggeredBy: string): Promise<{ groupId, newVersion, rewrappedCount }>` — remove from group, trigger rotation, re-wrap all file keys per target-architecture.md §4.4
- [ ] Re-wrapping: for each file in group, decrypt wrapped key with old group key, re-encrypt with new group key, update DB
- [ ] Key caching: LRU cache with TTL for group keys (1 minute) and file keys (5 minutes), invalidate on rotation
- [ ] Parallel key operations where possible (fetch multiple files' wrapped keys in batch)

**User Key Storage:**
- [ ] `storeUserKey(sub: string, accountId: string, keyData: Uint8Array): Promise<void>` — encrypt key material, store in DB under `user:{sub}` and `account:{accountId}`
- [ ] `retrieveUserKey(sub: string): Promise<{ accountId, privateKey, publicKey, network }>` — fetch from DB, decrypt, return (auth required)
- [ ] `retrieveUserKeyByAccount(accountId: string): Promise<{ ... }>` — same, indexed by account (auth required)
- [ ] `checkUserExists(sub: string): Promise<boolean>` — DB lookup, no decryption
- [ ] Store as single entry with both lookup indices (no duplicate blob storage — use DB relations, not separate writes)

**API Key Management:**
- [ ] `generateApiKey(accountId: string, version: number): Promise<{ apiKey, apiKeyHash }>` — derive `HKDF(masterSeed, "api-key:{accountId}:v{version}")`, hash with SHA-256, store hash in DB
- [ ] `verifyApiKey(apiKey: string): Promise<{ accountId, version } | null>` — hash input, lookup in DB, timing-safe comparison
- [ ] `rotateApiKey(accountId: string): Promise<{ apiKey, version }>` — increment version, derive new key, store new hash
- [ ] `hasApiKey(accountId: string): Promise<boolean>` — check if any API key exists for account
- [ ] API key format: `nova_sk_{base62(random || derived bytes)}`

**NEAR Integration:**
- [ ] Register group on NEAR contract on `generateGroupKey`
- [ ] Query group membership from NEAR contract for auth checks
- [ ] Record transactions on NEAR contract for file operations (maintain on-chain audit trail)
- [ ] Use `near-kit` for RPC calls (already in catalog), not raw `axios`/`fetch`
- [ ] Support both testnet and mainnet via network config
- [ ] Use `@near-js/crypto` and `@noble/ed25519` for signature verification

**Database Schema:**
- [ ] `group_keys` table: `id`, `group_id`, `version (int)`, `encrypted_key (text)`, `created_at`, `created_by`
- [ ] `user_keys` table: `id`, `user_sub (unique)`, `account_id (unique, indexed)`, `encrypted_key_data (text)`, `created_at`, `updated_at`
- [ ] `api_keys` table: `id`, `account_id`, `version (int)`, `key_hash (text, unique)`, `created_at`, `created_by`
- [ ] `group_members` table: `id`, `group_id`, `member_account_id`, `role (owner/member)`, `added_at`, `added_by` — mirrors on-chain state for fast lookups

**Auth Routes Implementation:**
- [ ] `GET /api/nova/getAuthChallenge` — returns `{ nonce, timestamp, expiresAt }`, stores nonce in DB with TTL
- [ ] `POST /api/nova/verifyAuthChallenge` — verifies Ed25519 signature, checks key ownership on-chain, consumes nonce atomically, returns session
- [ ] Nonce table: `id`, `nonce (text, unique)`, `account_id`, `created_at`, `expires_at` — auto-cleanup via TTL or cron
- [ ] Session integration with better-auth after successful challenge verification

### Notes
- [ ] Re-wrapping all file keys on member revocation is O(n) in number of files — acceptable for typical group sizes, but add a limit and warn
- [ ] Key caching must be process-safe for single-process deployments; use `@electric-sql/pglite` for local dev
- [ ] Do NOT store raw private keys in NEAR KV — use PostgreSQL with at-rest encryption
- [ ] On-chain group membership is the source of truth for auth checks; DB mirrors for query performance
- [ ] Follow the service factory pattern from `createUpvoteService` in `api/src/index.ts`

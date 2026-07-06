# Key Hierarchy, Group Management & NEAR Integration

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 for the contract and crypto utilities, to implement the three-tier key hierarchy and group management API. Auth is handled by better-near-auth — this ticket focuses on key operations and NEAR contract integration.

### Overview
Implement the key hierarchy from target-architecture.md §2: master seed → group key v{N} → file key. Build the key management service (`api/src/services/key-management.ts`) that handles group key generation, versioning, rotation on member revocation, and re-wrapping. User key storage/retrieval. All on-chain operations call the existing NEAR main contract (`nova-sdk.near`) — no new contracts needed.

### Acceptance Criteria

**Three-Tier Key Hierarchy:**
- [ ] Master seed → HKDF(`group:{groupId}:{network}:v{version}`) → GroupKey (32 bytes)
- [ ] GroupKey → HKDF(`file:{fileHash}`) → FileKey (32 bytes)
- [ ] All derivation uses `deriveKey()` from `api/src/lib/crypto.ts`
- [ ] Key versions are integers starting at 1, incremented on rotation
- [ ] Encrypted group keys stored in NEAR KV contract (`kv.store`) encryted blobs with TEE_KEY_SECRET — on-chain, TEE-gated writes

**Group Key Management (`api/src/services/key-management.ts`):**
- [ ] `generateGroupKey(groupId: string, ownerAccountId: string): Promise<{ groupId, version }>`
  - Derive group key v1 via HKDF
  - Encrypt group key with TEE_KEY_SECRET (or BETTER_AUTH_SECRET fallback)
  - Store encrypted key in NEAR KV contract: `kv.store("group-key:{groupId}:v1", encryptedKey)`
  - Call contract method `contract.register_group(groupId)` — creates group on-chain, emits `Registered` event
  - On-contract fee: 0.05 NEAR
- [ ] `getGroupKey(groupId: string, version?: number): Promise<Uint8Array>`
  - Fetch encrypted group key from KV: `kv.get("group-key:{groupId}:v{version}")`
  - Decrypt with TEE_KEY_SECRET
  - Verify caller is group member via contract `is_authorized(group_id, caller_id)`
- [ ] `rotateGroupKey(groupId: string, triggeredBy: string, reason: string): Promise<{ groupId, oldVersion, newVersion, rewrappedCount }>`
  - Verify caller is group owner via contract `get_group_owner(group_id)`
  - Derive v{N+1}, encrypt, store in KV: `kv.store("group-key:{groupId}:v{N+1}", newEncryptedKey)`
  - Re-wrap all existing file keys: decrypt wrapped key with old group key → re-encrypt with new group key → update DB
  - Update contract checksum: `contract.update_checksum(group_id, sha256(newGroupKey.toString('hex')))`
  - Emit audit event
- [ ] `revokeMember(groupId: string, memberId: string): Promise<{ groupId, newVersion, rewrappedCount }>`
  - Call contract `revoke_group_member(groupId, memberId)` — removes member on-chain, emits `Revoked` event. Contract owner calls are fee-exempt.
  - Trigger `rotateGroupKey` to generate new group key version
  - Re-wrap all existing file keys with new group key per target-architecture.md §4.4
- [ ] Re-wrapping: for each file in group, decrypt wrapped key with old group key, re-encrypt with new group key, update DB
- [ ] Key caching: LRU cache with TTL for group keys (1 minute) and file keys (5 minutes), invalidate on rotation
- [ ] Parallel key operations where possible (batch fetch wrapped keys)

**Group Data Queries (via contract):**
- [ ] `getOwnedGroups(accountId: string): Promise<string[]>` — contract `get_owned_groups()` (0.0001 NEAR fee)
- [ ] `getMemberGroups(accountId: string): Promise<string[]>` — contract `get_member_groups()` (0.0001 NEAR fee)
- [ ] `getGroupMembers(groupId: string, callerId: string): Promise<AccountId[]>` — contract `get_group_members(groupId)`, caller must be member (0.0001 NEAR fee)
- [ ] Mirror group member data in PostgreSQL `group_members` table for fast reads / API queries without hitting contract repeatedly

**User Key Storage (`api/src/services/key-management.ts`):**
- [ ] `storeUserKey(accountId: string, keyData: Uint8Array): Promise<void>` — encrypt key material, store in NEAR KV under `kv.store("user-key:{accountId}", encryptedBlob)`
- [ ] `retrieveUserKey(accountId: string): Promise<{ accountId, privateKey, publicKey, network }>` — fetch from KV, decrypt, return. Auth required (caller's session must match the target account or be an authorized API key).
- [ ] `checkUserExists(accountId: string): Promise<boolean>` — `kv.get("user-key:{accountId}")` → exists check, no decryption
- [ ] Store encrypted blobs in KV contract (TEE-gated writes, public reads) — blobs are encrypted, so public reads are safe

**Database Schema (mirror tables):**
- [ ] `group_members` table: `id`, `group_id`, `member_account_id`, `role (owner/member)`, `added_at` — mirrors on-chain state for fast lookups
- [ ] `group_keys` table: `id`, `group_id`, `version (int)`, `kv_key (text)`, `created_at`, `created_by` — tracks which KV keys exist for which group versions (the actual encrypted key is in NEAR KV)

**NEAR Integration:**
- [ ] Use `near-kit` for RPC calls (already in catalog), not raw `axios`/`fetch`
- [ ] Support both testnet and mainnet via network config
- [ ] Contract IDs from env vars: `NOVA_CONTRACT_ID`, `NOVA_KV_CONTRACT_ID`
- [ ] Fee management: estimate fees via `contract.estimate_fee(action)` before submitting
- [ ] Handle contract fees transparently — caller pays gas + contract fees
- [ ] Signer account for contract calls: derived NEAR account managed by bos runtime

**Parallel RPC Calls:**
- [ ] Where two RPC calls are independent (fetch access key + block hash), run in `Promise.all()`

### Notes
- [ ] Re-wrapping all file keys on member revocation is O(n) in number of files — acceptable for typical group sizes, but add a limit (warn above 1000 files)
- [ ] Key caching must be process-safe for single-process deployments; use `@electric-sql/pglite` for local dev
- [ ] On-chain group membership is the source of truth for auth checks; DB mirrors for query performance
- [ ] Follow the service factory pattern from `createUpvoteService` in `api/src/index.ts`
- [ ] NEAR KV contract `get()` is public — encrypted blobs are safe because they're encrypted with TEE_KEY_SECRET; KV keys use SHA-256 hashes so they're unguessable
- [ ] Contract `revoke_group_member` has an owner exemption (no fee when contract owner calls it) — useful for Shade/TEE-initiated revocations

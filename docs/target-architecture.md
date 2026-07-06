# NOVA — Target Architecture for Shared, Secure, Encrypted Memory

## 1. Security Model

### Authentication must prove identity, not assert it

Current: wallet key retrieval accepts a bare `wallet_id` or `account_id` with no cryptographic proof.

Target:

```
Email users:
  1. Auth0 OAuth → JWT access token
  2. Shade agent verifies JWT (JWKS + audience + issuer + expiry)
  3. Email extracted from verified JWT → used for key lookup

Wallet users:
  1. Client requests a nonce from shade agent: GET /api/auth/challenge?account_id=X
  2. Agent returns { nonce, timestamp }
  3. Client signs nonce with NEAR wallet: signMessage({ message: "auth:{nonce}", ... })
  4. Client sends POST /api/auth/verify with { account_id, nonce, signature, public_key }
  5. Agent verifies: (a) signature matches public_key for nonce, (b) public_key is an access key of account_id on NEAR, (c) nonce hasn't expired and hasn't been consumed
  6. Agent issues a short-lived session token (HS256 JWT, 5 min TTL)
```

### All key retrieval endpoints require a verified session

The `/api/user-keys/retrieve`, `/api/user-keys/check`, and `/api/key-management/get_key` endpoints must never return key material without an authenticated session or a valid NEAR-signed token.

### Session token flow for SDK/app access

```
1. App generates API key (once) via shade agent → stored as SHA256 hash in KV
2. App sends API key to POST /api/auth/session-token
3. Agent verifies hash against KV → issues JWT session token (24h TTL)
4. Subsequent requests include session token in Authorization header
```

---

## 2. Key Hierarchy

### Current: flat derivation

```
master_seed ──HKDF(salt)──▶ user_key / group_key / signer_key
```

All keys are derived at the same level. No per-file keys. Compromise of any derived key leaks only data encrypted with that key (but the master seed still secures everything).

### Target: three-tier hierarchy

```
                 ┌─────────────────┐
                 │   Master Seed   │  (encrypted with TEE_KEY_SECRET, stored in KV)
                 │   (32 bytes)    │
                 └───────┬─────────┘
                         │ HKDF(salt="group:{group_id}:{version}")
                         ▼
              ┌──────────────────────┐
              │   Group Key (v{N})   │  (rotated on member revocation)
              │   (32 bytes)         │
              └──────────┬───────────┘
                         │ HKDF(salt="file:{file_hash}")
                         ▼
              ┌──────────────────────┐
              │   File Key           │  (unique per file)
              │   (32 bytes)         │
              └──────────────────────┘
```

**Properties:**
- **Master seed** — never exposed, only used for HKDF derivation inside the TEE
- **Group keys** — versioned. A new version is created on every membership change
- **File keys** — derived per-file. Even if a file key is leaked, only that single file is compromised

### Key wrapping for on-chain storage

```
File content ──AES-256-GCM──▶ encrypted_file    (stored on IPFS)
                 │
            File Key
                 │
                 │ AES-256-GCM (key wrap)
                 ▼
           wrapped_file_key = encrypt(File Key, Group Key)
           stored on KV as: SHA256("file-key:{group_id}:{version}:{file_hash}")
```

The file key is wrapped with the group key and stored alongside the encrypted file. To decrypt: retrieve wrapped key, unwrap with group key, decrypt file.

---

## 3. Authenticated Encryption (AES-256-GCM)

### Current: AES-256-CBC, no authentication

```
format: IV(hex):ciphertext(hex)   ← no MAC, malleable
```

### Target: AES-256-GCM

```
format: IV(12 bytes) || ciphertext || auth_tag(16 bytes)
        └── sent as base64 or stored as raw bytes via NEAR KV
```

```
Encrypt:
  iv = random(12)
  cipher = aes-256-gcm(key, iv)
  ciphertext, auth_tag = cipher.encrypt(plaintext)

Decrypt:
  cipher = aes-256-gcm(key, iv, auth_tag)
  plaintext = cipher.decrypt(ciphertext)   ← throws if auth_tag mismatch
```

**Properties:**
- **Integrity**: Any ciphertext modification is detected (auth tag mismatch → error)
- **Authenticity**: Only parties with the key can produce valid ciphertexts
- No padding oracle attack surface

---

## 4. Shared Encrypted Memory Lifecycle

### 4.1 Group Creation

```
User → NEAR contract: register_group(group_id) [attached deposit for fee]
  ├─ Contract emits EVENT_JSON:Registered { group_id, owner }
  ├─ Indexer or direct call → Shade agent POST /api/key-management/generate_key
  └─ Agent derives group_key_v1 = HKDF(master_seed, "group:{group_id}:v1")
     Stores encrypted group key (wrapped with TEE_KEY_SECRET) in KV
     Returns { group_id, version: 1 } to caller
```

### 4.2 File Upload (end-to-end encrypted)

```
Client (browser/SDK):
  1. Request group key: POST /api/key-management/get_key { group_id, auth_token }
  2. Generate file_key = random(32)
  3. Encrypt file: encrypted_file = aes_256_gcm(file_content, file_key)
  4. Wrap file key: wrapped_key = aes_256_gcm(file_key, group_key)
  5. Calculate file_hash = SHA256(file_content)
  6. Upload encrypted_file → IPFS (Pinata) → get ipfs_hash
  7. Store wrapped_key in KV: SHA256("file-key:{group_id}:{version}:{file_hash}")
  8. Record transaction on NEAR contract: record_transaction(group_id, file_hash, ipfs_hash)
```

### 4.3 File Retrieval

```
Client:
  1. Request group key (as above, with auth)
  2. List transactions from NEAR contract: get_transactions_for_group(group_id)
  3. For target file_hash:
     a. Fetch wrapped_key from KV
     b. Unwrap: file_key = aes_256_gcm_decrypt(wrapped_key, group_key)
     c. Fetch encrypted_file from IPFS
     d. Decrypt: file_content = aes_256_gcm_decrypt(encrypted_file, file_key)
```

### 4.4 Member Revocation + Key Rotation

```
Owner → NEAR contract: revoke_group_member(group_id, member_id) [fee]
  ├─ Contract removes member, emits EVENT_JSON:Revoked
  └─ Shade agent POST /api/key-management/revoke_member { group_id, member_id }
     1. Verifies caller is group owner (on-chain check)
     2. Generates group_key_v{N+1}
     3. Re-wraps all existing file keys with new group key
     4. Stores new encrypted group key in KV
     5. Stores all re-wrapped file keys in KV
     6. Returns { group_id, new_version: N+1 }

All future uploads use group_key_v{N+1}.
The revoked member's copy of group_key_v{N} cannot decrypt new files.
```

---

## 5. Transaction Efficiency

### 5.1 Batch KV writes

**Current:** User key storage writes the same blob twice (under `user:{sub}` and `account:{account_id}`) as two separate NEAR transactions — two RPC round trips, two gas costs.

**Target:** Single transaction with batched actions:

```
Transaction {
  signerId: "kv-signer.nova-kv.near",
  receiverId: "nova-kv.near",
  actions: [
    FunctionCall { method: "store", args: { key: "user:{sub}", blob } },
    FunctionCall { method: "store", args: { key: "account:{id}", blob } }
  ]
}
```

Or: extend the KV contract with a `store_batch` method that accepts `Vec<(String, Vec<u8>)>` in a single call.

### 5.2 Blob compression before KV storage

**Current:** Raw JSON blobs stored as-is.

**Target:**

```
compressed_blob = deflate(JSON.stringify(keyData))
encrypted_blob = aes_256_gcm(compressed_blob, TEE_KEY_SECRET)
storeBlobToKV(key, encrypted_blob)   // ~30-60% smaller
```

### 5.3 KV read caching in TEE memory

**Current:** Every request fetches from KV via NEAR RPC (slow).

**Target:** LRU cache with TTL:

```
const kvCache = new Map<string, { data: Buffer; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute for group keys
const CACHE_TTL_USER_MS = 300_000; // 5 minutes for user keys

async function getBlobFromKV(key: string): Promise<Buffer | null> {
  const cached = kvCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchFromChain(key);
  if (data) kvCache.set(key, { data, ts: Date.now() });
  return data;
}
```

Invalidate cache entries on write to the same key.

### 5.4 Atomic nonce consumption

**Current:** Nonce verification is two steps (view call → transaction), creating a race condition window.

**Target:** Single contract call that atomically checks and consumes the nonce:

```rust
// contract: check_and_consume_nonce
pub fn check_and_consume_nonce(&mut self, nonce: String) -> bool {
    if self.used_nonces.contains_key(&nonce) {
        return false; // already used
    }
    self.used_nonces.insert(nonce, true);
    true
}
```

Or: use `broadcast_tx_commit` with a nonce-based `FunctionCall` action where the contract atomically checks-and-marks.

### 5.5 Parallel RPC calls where possible

```
// Instead of sequential:
const accessKey = await rpcCall(rpcUrl, accessKeyPayload);
const blockHash = await rpcCall(rpcUrl, blockHashPayload);

// Do parallel:
const [accessKey, blockHash] = await Promise.all([
  rpcCall(rpcUrl, accessKeyPayload),
  rpcCall(rpcUrl, blockHashPayload),
]);
```

---

## 6. Audit Trail

### Key access logging

Every key retrieval should emit a structured audit event:

```json
{
  "event": "key_access",
  "timestamp": "2026-06-25T12:00:00Z",
  "key_type": "group_key",
  "resource_id": "my-group",
  "version": 3,
  "requested_by": "alice.near",
  "authenticated_via": "near_signed_token",
  "outcome": "success"
}
```

These events can be:
- Logged by the shade agent (structured JSON to stdout → collected by log aggregator)
- Or recorded on-chain as lightweight events (gas permitting)

### What gets logged

| Event | Fields |
|---|---|
| `key_access` | key_type, resource_id, version, requested_by, auth_method, outcome |
| `key_rotation` | group_id, old_version, new_version, triggered_by, reason (manual/revocation) |
| `member_revoked` | group_id, member_id, new_version, rewrap_count (number of file keys re-wrapped) |
| `auth_failure` | attempted_method, reason, ip_hash, user_agent_hash |
| `kv_store` | key_hash, blob_size_compressed, blob_size_raw |
| `kv_read` | key_hash, cache_hit |

No PII in audit events — account IDs only, no emails, no raw tokens.

---

## 7. Resilience

### 7.1 Agent startup: non-blocking

**Current:** Server blocks in `while(true)` until whitelisted.

**Target:** Start HTTP server immediately. Serve `/health` as `degraded` while not whitelisted, `healthy` once registered.

```
const app = new Hono();

// Start server BEFORE registration
serve({ fetch: app.fetch, port: 3000 });

// Register in background
registerAgent().catch(err => { /* retry loop in background */ });
```

Health endpoint:

```json
{ "status": "degraded", "agent_registered": false, "uptime_seconds": 30 }
→ { "status": "healthy", "agent_registered": true, "uptime_seconds": 120 }
```

### 7.2 RPC circuit breaker

Wrap all NEAR RPC calls with a circuit breaker:

```
State: CLOSED → after N failures in window → OPEN → after timeout → HALF_OPEN → ...
                                                              ↓ success → CLOSED
                                                              ↓ failure → OPEN
```

In OPEN state, return cached data if available or error immediately (don't pile on retries).

### 7.3 Graceful degradation

| Dependency | Degraded behavior |
|---|---|
| NEAR RPC unreachable | Return cached KV reads, reject writes with retry-after |
| KV contract unreachable | Same as above |
| IPFS/Pinata unreachable | Queue uploads for later, allow retrievals of already-stored files |
| Auth0 JWKS unreachable | Reject new auth, allow existing session tokens until expiry |

---

## 8. Observability

### 8.1 Structured logging (no PII)

Replace all `console.log(accountId, email, walletId)` with structured logging:

```
log.info('auth_success', { auth_method: 'auth0', token_hash: sha256(token).slice(0,8) })
log.info('key_retrieved', { key_type: 'user_key', lookup_method: 'email' })
log.error('rpc_failure', { rpc_url: masked, attempt: 2, error: err.message })
```

Never log: emails, full tokens, private keys, wallet IDs, account IDs in error messages.

### 8.2 Metrics

Export via `/metrics` (Prometheus format) or structured log events:

| Metric | Type | Description |
|---|---|---|
| `kv_store_duration_ms` | histogram | KV write latency |
| `kv_read_duration_ms` | histogram | KV read latency |
| `contract_call_total` | counter | Contract calls by method |
| `contract_call_errors_total` | counter | Failed contract calls |
| `auth_requests_total` | counter | Auth attempts by method |
| `auth_failures_total` | counter | Failed auth by reason |
| `active_sessions` | gauge | Current valid session tokens |
| `cache_hit_ratio` | gauge | KV cache hit rate |

---

## 9. Code Architecture

### 9.1 DRY: shared utility modules

Replace the duplicated code across routes with a single source of truth:

```
shade-agent/src/
  routes/
    user-keys.ts        → imports from ../lib/*
    key-management.ts   → imports from ../lib/*
  lib/
    crypto.ts           → encryptBlob, decryptBlob, deriveKey, getMasterSeed
    kv.ts               → getBlobFromKV, storeBlobToKV, batchStore
    near-rpc.ts         → rpcCallWithRetry, broadcastTx, fetchAccessKey
    auth.ts             → verifyAuth0Token, verifyNearSignature, issueSessionToken
    attestation.ts      → getAttestation (real implementation)
    logger.ts           → structured logging helper
    config.ts           → centralized env/network config (no more hardcoded RPC URLs)
```

### 9.2 Unified error handling

```typescript
class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// Route handler pattern:
try {
  // ... business logic
} catch (err) {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.statusCode);
  }
  log.error('unhandled_error', { error: err.message });
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
}
```

### 9.3 Input validation

All endpoints should validate request bodies before processing:

```typescript
const schema = z.object({
  email: z.string().email().optional(),
  auth_token: z.string().optional(),
  account_id: z.string().regex(/^[a-z0-9._-]+\.(near|testnet)$/).optional(),
  wallet_id: z.string().optional(),
}).refine(data => /* at least one auth method present */);

const parsed = schema.safeParse(await c.req.json());
if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
```

---

## 10. Frontend Architecture

### 10.1 TanStack Query for all data fetching

Replace raw `fetch()` + `useState` with React Query:

```typescript
const { data: groups, isLoading } = useQuery({
  queryKey: ['groups', accountId],
  queryFn: () => fetchGroups(accountId),
  staleTime: 30_000,
  retry: 2,
});
```

### 10.2 Cache-Control strategy

```
/:path                                   → no-store (dynamic HTML)
/_next/static/*                         → public, max-age=31536000, immutable
/_next/image/*                          → public, max-age=86400
/api/*                                  → no-store
/fonts/*, /favicon.ico, /logo.svg       → public, max-age=604800
```

### 10.3 Single-source CSP

Remove the `<meta>` CSP from `layout.tsx`. Maintain CSP only in `next.config.ts` headers. Add missing `connect-src` entries to the header version.

---

## 11. Key Rotation & Revocation

### API key rotation

Current: keys are deterministic — always the same for a given account. Cannot be rotated.

Target: Store a `key_version` counter per account in KV. Derive keys as:

```
api_key = HKDF(master_seed, "api-key:{account_id}:v{key_version}")
api_key_hash = SHA256(api_key)
```

Increment `key_version` to rotate. Store `key_version` and `api_key_hash` in KV. New key invalidates old tokens.

### Group key rotation (forward secrecy)

On member revocation:
1. Increment group key version
2. Re-wrap all existing file keys with new group key (server-side in TEE)
3. Revoked member's old group key cannot decrypt new uploads
4. Previously uploaded files remain decryptable by the revoked member (they have the old key and already had access) — this is the expected tradeoff; true forward secrecy for past files requires re-encryption of all historical files, which is impractical for IPFS-stored content

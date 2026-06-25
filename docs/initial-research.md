# NOVA — Initial Research & Code Audit

## System Overview

```
┌──────────────────────────────┐
│  nova-landing (Next.js 16)   │  Auth0 OAuth + NEAR Wallet
│  https://nova-sdk.com        │  Chat UI (Vercel AI SDK)
└──────┬───────────┬───────────┘
       │           │
       │ REST      │ Auth0 callbacks
       ▼           ▼
┌──────────────┐  ┌──────────────────────┐
│  MCP Server  │  │  Shade Agent (Hono)  │
│  (Python)    │◄─┤  TEE CVM (Phala)     │
│  Port 8000   │  │  Port 3000           │
└──────┬───────┘  └──────────┬───────────┘
       │                     │
       │ NEAR contract calls │ KV contract RPC
       ▼                     ▼
┌──────────────────────────────────────┐
│  NEAR Blockchain                     │
│  nova-sdk.near (core contract)       │
│  nova-kv.near  (encrypted KV store)  │
└──────────────────────────────────────┘
```

**Services:**

| Service | Language | Framework | Role |
|---|---|---|---|
| shade-agent | TypeScript | Hono + ShadeClient | TEE key management, KV persistence |
| mcp-server | Python | FastMCP + Starlette | Public API, NEAR contract proxy, IPFS |
| nova-landing | TypeScript | Next.js 16 + React 19 | Multi-user web UI + chat |
| contract | Rust | near-sdk 5.x | Groups, members, transactions, fees |
| kv-contract | Rust | near-sdk 5.x | Encrypted blob key-value store |

**Auth model:** Hybrid — Auth0 JWT for email users, `wallet_id` parameter for wallet users, NEAR-signed tokens for contract calls.

---

## shade-agent (`shade-agent/src/`)

### CRITICAL — Wallet-based key retrieval has no verification

**Files:** `src/routes/user-keys.ts:561-567`

```typescript
// Wallet users: no verification, but require wallet_id
else if (!walletId) {
  return c.json({ error: 'Missing auth_token (email) or wallet_id (wallet)' }, 400);
}
// ...
const sub = verifiedUser?.sub || (walletId ? `wallet|${walletId}` : null);
```

**What happens:** When a `wallet_id` is provided without an `auth_token`, the endpoint skips all cryptographic verification. It constructs `sub = "wallet|{wallet_id}"`, hashes it, fetches the encrypted blob from KV, decrypts it, and returns the user's private key.

**Impact:** Wallet IDs are public on-chain. Anyone who knows a user's NEAR account can retrieve their private key by calling this endpoint. No signature, challenge, or proof of ownership is required.

---

### CRITICAL — Account-based key retrieval bypasses all auth

**Files:** `src/routes/user-keys.ts:535-552`

```typescript
if (account_id && !email && !auth_token && !walletId) {
  const accountKeyId = crypto.createHash('sha256')
    .update(`account:${account_id}`).digest('hex');
  const encryptedBlob = await getBlobFromKV(accountKeyId);

  if (!encryptedBlob) return c.json({ error: 'Account not found' }, 404);

  const decrypted = Buffer.from(decryptBlob(encryptedBlob)).toString('utf8');
  const userData = JSON.parse(decrypted);

  return c.json({
    account_id: userData.account_id,
    private_key: userData.private_key,
    public_key: userData.public_key,
    network: userData.network,
    wallet_id: userData.wallet_id,
    ...
  });
}
```

**What happens:** If only `account_id` is provided (no `email`, no `auth_token`, no `wallet_id`), the endpoint returns the full key material — no authentication of any kind.

**Impact:** NEAR account IDs are public. Any stored private key is retrievable by anyone. This is the `/retrieve` endpoint and it is called from multiple places in the codebase.

---

### CRITICAL — Exposed API token committed to repository

**Files:** `shade-agent/near-rpc.json:7`

```json
"Authorization": "Bearer 0b1399596423db51740cfbe041490f6a7611a6b0089d30afb7d459939723171c"
```

**What happens:** A live FastNEAR API token is committed in plaintext.

**Impact:** Anyone with read access to the repo can use this token to access the FastNEAR RPC endpoint.

---

### HIGH — Master seed can be silently overwritten

**Files:** `src/routes/key-management.ts:26-48`

```typescript
const MASTER_SEED_INIT_ALLOWED = process.env.MASTER_SEED_INIT_ALLOWED === 'true';
if (MASTER_SEED_INIT_ALLOWED) {
  console.warn('⚠️ MASTER_SEED_INIT_ALLOWED=true: Force re-initializing master seed!');
  // ... derives new seed from sponsor key ...
  masterSeed = newSeed;
  const encrypted = encryptBlob(newSeed);
  await storeBlobToKV('master-root', encrypted);
  return masterSeed;
}
```

**What happens:** Unlike `user-keys.ts` (which checks if KV is empty first), the `key-management.ts` version unconditionally overwrites the master seed whenever `MASTER_SEED_INIT_ALLOWED=true`.

**Impact:** If this env var is accidentally left set after initial deployment, every subsequent request regenerates a new master seed, overwrites it on-chain, and **all previously stored keys become permanently unrecoverable**. All user keys, group keys, and signer keys are derived from this master seed — changing it breaks everything.

---

### HIGH — Infinite blocking loop at startup

**Files:** `src/index.ts:68-83`

```typescript
while (true) {
  try {
    const isWhitelisted = await agent.isWhitelisted();
    if (isWhitelisted === null || isWhitelisted) {
      const registered = await agent.register();
      if (registered) {
        console.log("✅ Agent registered successfully");
        break;
      }
    }
  } catch (error) { ... }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
```

**What happens:** The server enters an infinite `while(true)` loop during startup and will never bind its HTTP port until the agent is whitelisted and registered.

**Impact:** If the agent is never whitelisted (e.g., misconfigured deployment, contract not deployed, wrong sponsor key), the server never starts. No health checks, no graceful degradation, no timeout.

---

### HIGH — AES-256-CBC without authentication

**Files:** `src/routes/user-keys.ts:95-99`, `src/routes/key-management.ts:83-92`, `src/utils/derivation.ts`

```typescript
function encryptBlob(data: Uint8Array): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
  let encrypted = cipher.update(data);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}
```

**What happens:** Blobs stored on-chain are encrypted with AES-256-CBC without a MAC (Message Authentication Code). The format is `IV:ciphertext` with no authentication tag.

**Impact:** CBC mode without authentication means:
- Ciphertexts are **malleable** — an attacker who can modify KV contract storage could manipulate ciphertexts without detection
- No integrity verification on decryption
- Vulnerable to padding oracle attacks in contexts where decryption errors are distinguishable

---

### HIGH — Token signature verification skips key ownership check

**Files:** `src/routes/key-management.ts` — `verifyToken()` function

**What happens:** When a signed token contains `signing_pk_b58`, the code verifies the signature against that key. However, it does **not verify that this key actually belongs to the claimed `user_id`**. An attacker can create a token signed with any key they control and include that key's base58 encoding in the payload.

**Impact:** Bypass of on-chain key verification. The code path should verify that `signing_pk_b58` matches a known access key for the `user_id` on NEAR.

---

### MEDIUM — Massive code duplication across routes

**Duplicated blocks (near-identical in 2-4 locations):**

| Function/Location | user-keys.ts | key-management.ts | utils/derivation.ts | utils/kv-contract.ts |
|---|---|---|---|---|
| `encryptBlob` | :95-99 | :83-92 | — | — |
| `decryptBlob` | :102-128 | :95-141 | — | — |
| `getBlobFromKV` | :162-200+ | ~:330+ | — | :14-70 |
| `storeBlobToKV` | ~:210-290+ | ~:257-320+ | — | :74-138 |
| `borshString` / `borshBytes` / `borshU64` / `borshU128` | ~:130+ | ~:140+ | — | — |
| `encodeFunctionCallAction` | ~:150+ | ~:160+ | — | — |
| `encodeTransaction` | ~:170+ | ~:180+ | — | — |
| `rpcCallWithRetry` | :138-160 | :~similar | — | — |
| `log` helper | :134-136 | :~similar | — | — |
| `getAttestation` (stub) | ~: | ~: | — | — |
| HKDF derivation | :86-93 (Node crypto) | :66-75 (Node crypto) | :60+ (@noble/hashes) | — |

**Impact:** Any bug fix or security improvement must be applied in 3-4 places. The `utils/` files exist but are **not imported by the route files** — each route reimplements everything inline. The utils use `@noble/hashes` for HKDF while routes use Node `crypto.hkdfSync` — these could produce different results if they diverge.

---

### MEDIUM — Hardcoded mainnet RPC URL in all read operations

**Files:** `src/routes/user-keys.ts:163`, `src/routes/key-management.ts:~330`, `src/utils/kv-contract.ts:9`

```typescript
// user-keys.ts:163
const rpcUrl = 'https://rpc.mainnet.near.org'; // or testnet

// kv-contract.ts:9
const MAINNET_RPC = 'https://rpc.mainnet.near.org';
```

**What happens:** `getBlobFromKV` hardcodes mainnet RPC. Write operations (`storeBlobToKV`) do check `process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org'`.

**Impact:** When deployed on testnet, all KV **reads** silently talk to mainnet RPC. This means testnet deployments cannot read stored blobs correctly — the mainnet KV contract won't have testnet data. The behavior is asymmetric (writes work, reads don't), making this bug extremely hard to diagnose.

---

### MEDIUM — TEE attestation entirely stubbed out

**Files:** `src/routes/user-keys.ts`, `src/routes/key-management.ts` — `getAttestation()` in both

```typescript
return { provider: 'local', pcr0: devPcr0, verified: false };
```

**What happens:** Real Nitro enclave attestation code is commented out with a TODO. Every API response claims `verified: false`. In production on Phala CVM, this means attestation verification is completely bypassed — callers cannot cryptographically verify they are talking to a genuine TEE.

---

### LOW — Missing input validation and size limits

**All endpoints** in both `user-keys.ts` and `key-management.ts` parse request bodies with `await c.req.json()` with no size limits. A malicious client can send arbitrarily large JSON payloads.

---

### LOW — Debug endpoint returns hardcoded data

**Files:** `src/routes/key-management.ts` — `GET /api/key-management/debug/groups`

Returns `['example-group-1', 'example-group-2']` — not actual data. Should be removed or wired to real state.

---

### LOW — Dead `void generateApiKey` statement

**Files:** `src/routes/user-keys.ts:855`

```typescript
void generateApiKey;
```

A no-op referencing a local function. Appears to be leftover debugging code.

---

## nova-landing (`nova-landing/`)

### CRITICAL — Backwards network-switch link

**Files:** `src/components/Header.tsx:54-55`

```typescript
const isTestnet = process.env.NEXT_PUBLIC_NEAR_NETWORK !== 'mainnet';
const networkUrl = isTestnet ? 'https://nova-sdk.com' : 'https://testnet.nova-sdk.com';
```

**What happens:** When `isTestnet` is `true`, `networkUrl` is set to `https://nova-sdk.com` (mainnet). When `isTestnet` is `false`, `networkUrl` is set to `https://testnet.nova-sdk.com`. The URLs are swapped.

**Impact:** The "Testnet" badge links to the mainnet site, and the "Mainnet" badge links to the testnet site. Users clicking the network switch indicator are taken to the wrong environment.

---

### CRITICAL — Debug endpoint exposes access tokens in production

**Files:** `src/app/api/debug/token/route.ts:1-21`

```typescript
export async function GET() {
  const token = await getAuthToken();
  return NextResponse.json({
    access_token: token,
    note: 'Delete this endpoint after testing!'
  });
}
```

**Impact:** Raw Auth0 access tokens are returned to any caller. If deployed publicly, this exposes valid access tokens.

---

### HIGH — `Cache-Control: no-store` on all paths including static assets

**Files:** `next.config.ts:41-48`

```typescript
{
  source: '/:path*',
  headers: [
    { key: 'Cache-Control', value: 'no-store, max-age=0' },
  ],
}
```

**What happens:** The `/:path*` pattern matches everything including `/_next/static/*` (JS bundles, CSS) and `/_next/image` (optimized images).

**Impact:** Every page load re-downloads all static assets. No browser caching for any resource. Massive bandwidth waste and degraded UX.

---

### HIGH — Conflicting CSP: HTTP header overrides meta tag

**Files:** `next.config.ts:28-37` (HTTP header CSP) vs `src/app/layout.tsx:32-41` (meta tag CSP)

The two CSPs have different directives:
| Directive | next.config.ts (active) | layout.tsx (dead) |
|---|---|---|
| `connect-src` | Has `nearblocks.io` | Has `nearblocks.io` + relayer URLs |
| `frame-src` | Has `crypto-js.stripe.com` | Missing Stripe |

**Impact:** HTTP header CSP takes precedence. The layout.tsx CSP is dead code. The Stripe `frame-src` is only in the header version (which is correct), but the layout.tsx copy creates confusion. If someone modifies only the layout.tsx CSP, their changes will have no effect.

---

### HIGH — `ignoreBuildErrors: true` silences type errors

**Files:** `next.config.ts:8`

```typescript
typescript: {
  ignoreBuildErrors: true,
}
```

**Impact:** TypeScript errors in the build pipeline are ignored. Real type errors indicating runtime bugs are swallowed. Combined with no CI checks, this means type safety is bypassed.

---

### HIGH — Five overlapping `useEffect` hooks with race conditions

**Files:** `src/app/HomeClient.tsx`

The component has 5+ `useEffect` hooks with overlapping dependency arrays (`!loading`, `isSignedIn`, `novaAccountVerified`, `isPaymentOpen`). The main verification effect depends on `novaAccountVerified` in its deps but also sets it, creating potential infinite loops. Additional OAuth cleanup effects call `window.location.href = "/"` (full page reload), which can interrupt in-progress verification flows.

**Impact:** Race conditions in auth flow: verification can be interrupted mid-flight by page reloads, duplicate API calls fire during state transitions, and modal states can become inconsistent.

---

### MEDIUM — TanStack React Query unused

**Files:** `src/components/Providers.tsx`

`QueryClientProvider` wraps the entire app. Zero `useQuery`/`useMutation`/`useInfiniteQuery` calls exist anywhere. All data fetching uses raw `fetch()` with manual `useState` loading/error flags.

**Impact:** Additional library weight with no benefit. No caching, deduplication, retry, or stale-while-revalidate patterns.

---

### MEDIUM — PII logged to console across codebase

**Files:** `HomeClient.tsx`, `ChatInterface.tsx`, `LoginModal.tsx`, `WalletProvider.tsx`

Account IDs, wallet IDs, email addresses, and partial JWT tokens are logged via `console.log` throughout the client code.

**Impact:** In production, this data appears in browser console and any log aggregation. Violates privacy best practices.

---

### MEDIUM — Unawaited Promise in WalletProvider cleanup

**Files:** `src/providers/WalletProvider.tsx`

```typescript
const cleanup = init();
return () => {
  mounted = false;
  cleanup?.then(cleanupFn => cleanupFn?.());
};
```

**What happens:** React `useEffect` cleanup does not await Promises. If the component unmounts before `init()` resolves, the unsubscribe function never executes.

**Impact:** Wallet event listeners may leak on rapid mount/unmount cycles.

---

### LOW — Next.js dev overlay hidden globally

**Files:** `src/app/globals.css:74-77`

```css
#__next_dev_overlay,
#__next_dev_overlay * {
  display: none !important;
}
```

Hides the Next.js error overlay. Makes debugging development errors impossible.

---

### LOW — `localStorage.clear()` on logout destroys NEAR keystore

**Files:** `src/components/Header.tsx:40-41`

```typescript
sessionStorage.clear();
localStorage.clear();
```

**Impact:** Clears ALL localStorage, including NEAR wallet keys injected by `src/lib/nearWallet.ts` and any other data stored by other scripts on the domain. A targeted key removal would be safer.

---

### LOW — Dead `asChild` prop on Button component

**Files:** `src/components/ui/button.tsx`

The `asChild` prop (from shadcn/ui pattern) is defined but never used.

---

### LOW — `eslint` script has no file arguments

**Files:** `package.json`

`"lint": "eslint"` — no target files specified. May not lint correctly depending on eslint config.

---

### LOW — Duplicate `const shadeUrl` declaration

**Files:** `src/app/api/auth/session-token/route.ts:37,79`

Same variable declared twice in the same function body (in different conditional arms).

---

### LOW — `reactCompiler: true` + `babel-plugin-react-compiler` redundancy

**Files:** `next.config.ts:5`, `package.json` devDependencies

Next.js 16 natively enables React Compiler. The `babel-plugin-react-compiler` in devDependencies is redundant.

---

## mcp-server (`mcp-server/`)

### MEDIUM — SQLite `check_same_thread=False`

**Files:** `server.py` — SQLite connection initialization

```python
sqlite3.connect('nova-users.db', check_same_thread=False)
```

**Impact:** Discouraged for production. Can lead to database corruption in concurrent request environments. A connection pool or proper async wrapper would be safer.

---

### MEDIUM — In-memory state with manual expiry

**Files:** `server.py` — `PENDING_UPLOADS` dict, `TESTNET_MOCK_FILES` dict

Upload preparation state is held in a process-memory dict with manual 5-minute expiry via cleanup loops. If the process restarts, all pending uploads are lost. No persistence for this state.

---

## contract + kv-contract (Rust/NEAR)

### MEDIUM — Nonce replay window under concurrency

**Files:** `contract/src/lib.rs` — nonce validation, `shade-agent/src/routes/key-management.ts` — `verifyToken()`

The token verification flow:
1. Check timestamp freshness (5-minute window)
2. Check nonce validity on-chain

If two requests with the same nonce arrive simultaneously, both could pass step 1 before either marks the nonce as used in step 2.

**Impact:** Replay attack window under concurrent requests. The nonce check-and-set should be atomic (single contract call).

---

### MEDIUM — Redundant KV blob storage

**Files:** `shade-agent/src/routes/user-keys.ts`

When a user stores keys, the same encrypted blob is written under **two keys**:
- `SHA256("user:{sub}")` — indexed by user identifier
- `SHA256("account:{account_id}")` — indexed by NEAR account

**Impact:** Double storage cost (NEAR gas) for the same data. If the two copies diverge (e.g., one write fails), lookup becomes inconsistent.

---

### LOW — Duplicate index maintenance in `register_group`

**Files:** `contract/src/lib.rs:171-195`

When registering a group, the contract adds the group to `owned_groups`, `member_groups`, and `group_transactions` — each requiring a read-all-copy-append-write pattern (no `Vec::push` on existing `LookupMap` entries without reconstructing the `StoreVec`).

**Impact:** O(n) gas cost in number of existing groups. Acceptable for small numbers of groups but could be optimized with direct `Vector` mutation patterns.

---

### LOW — Hardcoded fees in contract init

**Files:** `contract/src/lib.rs:77-87`

All action fees are hardcoded at contract deployment. Only the owner can update them via `set_fee`. No dynamic fee mechanism (the `get_dynamic_fee` stub returns `0`).

---

## Cross-Cutting Issues

### No key rotation mechanism for API keys

API keys, once generated, cannot be rotated. The deterministic derivation always produces the same key. Compromised keys cannot be revoked short of changing the master seed (which breaks everything).

### No rate limiting outside `user-keys`

Only `user-keys.ts` has a `rateLimitMap` (10 req/min per IP). `key-management.ts` and the MCP server have no rate limiting.

### No structured error handling pattern

Errors are handled inconsistently across services: some return JSON `{ error: ... }` with HTTP status codes, some throw, some log to console. No unified error format, no error codes for clients to programmatically handle.

### Production logging leaks PII

Account IDs, email addresses, wallet IDs, and partial tokens appear in `console.log` across all services. The `log()` helper in the shade agent serializes to JSON but does not redact sensitive fields.

### No CI/CD pipeline

No GitHub Actions workflows, no linting/typecheck in CI, no automated tests. `bun` commands referenced in the orphaned `docs/epics/001-tech-debt.md` don't apply — this codebase uses neither `bun` nor `better-auth`.

### Orphaned documentation

`docs/epics/001-tech-debt.md` and `docs/_template.md` reference technologies that don't exist in this codebase: better-auth, Sputnik DAO, oRPC, TanStack Router, everything-dev, Railway, bun typecheck. These appear to be copied from another project.

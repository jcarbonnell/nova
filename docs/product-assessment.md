# NOVA — Product Assessment

## What It Claims To Be

From the landing page and README: "NOVA is a privacy-first, decentralized file-sharing primitive, empowering user-owned AI with encrypted data persistence."

The pitch: upload encrypted files, share them with groups via on-chain access control, let AI agents interact with your data. Privacy. Decentralization. User sovereignty.

## What It Actually Is

NOVA is an **end-to-end encrypted file storage pipeline** with three layers:

1. **Client-side encryption** — files encrypted in the browser (AES-256-GCM per new target architecture; currently AES-256-CBC without authentication)
2. **On-chain access control** — a NEAR smart contract manages groups, members, and records file operations as tamper-proof transactions
3. **TEE key management** — a Shade Agent running in Phala Trusted Compute stores and serves encryption keys inside hardware enclaves, so even the operator cannot access plaintext

A user creates a group, adds members, encrypts a file, uploads it to IPFS, and records the transaction on NEAR. Group members can retrieve and decrypt. Every file operation creates an on-chain transaction — an immutable, verifiable access log.

The AI chat interface is a thin tool-calling wrapper around these primitives. It is not an agent, it has no persistent memory, and it does not "own" anything. It is a UI convenience, not a core feature.

## What It's Good At

### 1. Verifiable access logs

Every upload, retrieval, and membership change creates an on-chain transaction. A third party can independently verify the full history without trusting NOVA's servers. This is not achievable with a traditional database — the operator can always alter their own logs.

### 2. Client-side encryption with no trust in infrastructure

Files are encrypted before they leave the user's machine. IPFS nodes see ciphertext. The TEE operator cannot access plaintext (the master seed is encrypted with a TEE-specific key). Even NOVA itself cannot read user data.

### 3. Tamper-proof group membership

Adding or removing a group member is an on-chain transaction. The membership state is publicly verifiable. No one can silently add themselves to a group or remove someone else.

### 4. Non-repudiation in shared workflows

Because every action is signed and on-chain, participants cannot deny their actions. This is the core property that distinguishes NOVA from Google Drive, Dropbox, or any centralized equivalent.

### 5. Multi-agent state with audit

Agents (backend services) can share encrypted state through groups, with every read/write recorded on-chain. This gives orchestrators a tamper-proof paper trail of which agent did what, when. The primitives (groups, members, upload, retrieve, transactions) map cleanly to agent collaboration patterns without the human chat UI.

## What It's Not Good For

### 1. General-purpose file sharing

For sharing cat photos or team documents, Google Drive is faster, cheaper, and easier. Users should not need a NEAR wallet, gas tokens, or blockchain confirmations to share a PDF.

### 2. Real-time collaboration

Blockchain transaction confirmation takes 1-3 seconds. NOVA cannot support real-time co-editing, live cursors, or instant messaging. It is an async, batch-oriented system.

### 3. Consumer AI chat

The current implementation wraps a Claude chatbot with tool calls. There is no persistent agent memory, no autonomous behavior, no learning. Removing or rebuilding this layer would clarify the product.

### 4. High-frequency write workloads

Pay-per-action gas fees (0.001-0.05 NEAR per operation) make thousands of writes per minute impractical. Needs sponsored transactions or flat-rate billing.

### 5. Users who don't independently value auditability

If the verifiable access log is not the reason someone chooses NOVA, they are paying blockchain overhead for no benefit. The audit trail is the product. Everything else is implementation.

## Refined Value Proposition

> **Verifiable, privacy-preserving shared storage for applications where access records must be auditable by third parties.**

This narrows the product to scenarios where all three properties are required simultaneously:

- **Privacy** — data must remain encrypted to all parties except authorized group members
- **Shared** — multiple parties need access to the same encrypted data
- **Verifiable** — a third party must be able to independently verify who accessed what, when

If a use case only needs two of the three, a simpler solution exists. All three together? That's what NOVA provides.

## Use Cases That Fit

### Hackathon submissions + judging (validated)

```
Submitter → encrypts entry → uploads to NOVA group
  → on-chain: "Alice submitted entry hash H at time T"

Judge → retrieves entry → decrypts → scores
  → on-chain: "Judge Bob accessed entry H at time T2"

Auditor → reads on-chain log → verifies timeline
  → "Did all entries arrive before deadline?"
  → "Did any judge view an entry outside the judging window?"
  → "Were entries tampered with after submission?"
```

**Why it needs all three properties:**
- **Privacy**: Submissions are encrypted so other contestants cannot read them
- **Shared**: Judges are group members who need access
- **Verifiable**: The hackathon organizer (or the community) can audit the timeline without trusting a server

### Clinical trial data sharing

```
Pharma company A → uploads encrypted trial results to group
Regulator → added as group member → retrieves, reviews
Pharma company B (partner) → added for joint analysis

On-chain: full audit trail of every access, every member change
  → Regulators verify data was never accessed by unauthorized parties
  → Companies prove to each other they didn't tamper with shared data
```

### Government inter-agency document sharing

```
Agency A → uploads classified document → adds Agency B as member
Agency B → retrieves, reviews, uploads response
FOIA requester → reads on-chain access log → verifies timeline

On-chain:
  → "Did the document exist at the alleged timestamp?"
  → "Which agencies accessed it and when?"
  → "Were there unauthorized accesses?"
```

### Grant proposal review

```
Funding body → creates group per proposal batch
Reviewers → added as members → retrieve proposals → submit encrypted reviews
Auditor → verifies: no reviewer accessed proposals outside their assignment,
             all reviews submitted before deadline, no proposal altered after submission
```

### Bug bounty / vulnerability disclosure

```
Researcher → encrypts vulnerability details → uploads to group
Security team → retrieves, verifies, triages
Disclosure timeline is cryptographically verifiable on-chain
  → "Who reported first?" (immutable timestamp)
  → "When did the team review it?"
  → "What was the resolution timeline?"
```

### Multi-agent orchestration

```
Orchestrator → creates group "task-42"
Adds agents: reviewer-A, reviewer-B, summarizer

Orchestrator → uploads encrypted PR diff
  → on-chain: "orchestrator published diff D at T0"

reviewer-A → retrieves diff → analyzes → uploads encrypted findings
  → on-chain: "agent-A published findings F1 at T1"

reviewer-B → same, independently
  → on-chain: "agent-B published findings F2 at T2"

summarizer → retrieves F1, F2 → merges → uploads final report
  → on-chain: "summarizer published report R at T3"

Auditor → reads on-chain log
  → "Was the pipeline executed in the correct order?"
  → "Did any agent fail to complete its task (no output transaction)?"
  → "Is the output consistent with the inputs (hash chain)?"
```

**Why multi-agent fits:**
- **Privacy**: Intermediate agent outputs are encrypted, visible only to authorized agents
- **Shared**: Agents are group members, collaborating on the same task context
- **Verifiable**: The orchestrator and external auditors get a tamper-proof execution trace
- **Non-repudiation**: An agent cannot claim it completed a task without an on-chain record
- **Composability**: One agent's output becomes the next agent's input, with the chain proving the data lineage

**What's missing for agent use today:**
- Service account auth (agents shouldn't use email OAuth)
- Query/indexing ("give me all files uploaded in the last hour by agent-X")
- Lower latency and cost (agents operate at much higher throughput than humans)
- SDK ergonomics with retry, batching, and error handling

## Use Cases That Don't Fit

### General file sync (Dropbox/Drive replacement)

If there's no auditor — just a team sharing files — a centralized service is faster and simpler. The blockchain adds cost and latency with no benefit.

### Real-time chat or co-editing

1-3 second transaction confirmation makes synchronous collaboration impractical. NOVA is async.

### Content distribution / CDN

IPFS is slow for end-user retrieval compared to a CDN. Adding a CDN layer would undermine the decentralization argument.

### AI agent "memory" (as currently positioned)

The AI has no persistent state, no learning, no autonomy. It is a chatbot with tool access. Using NOVA as its "memory" is using a distributed encrypted filesystem as a key-value store — technically possible but not what the product should optimize for. The multi-agent collaboration pattern above is a better fit: agents as peers exchanging encrypted state, with the chain as the arbiter.

## What Needs to Change

### Critical (blocks the refined value prop)

1. **Auth**: Wallet users must prove identity (challenge/response), not assert it (wallet_id parameter). Account-based key retrieval must require authentication. See `docs/initial-research.md` — 3 critical auth vulnerabilities.

2. **Attestation**: The TEE must produce verifiable attestations (`verified: true` with real PCR0 values). The `verified: false` stub defeats the purpose of running in a TEE. Callers must be able to cryptographically verify they're talking to the genuine enclave.

3. **Encryption upgrade**: AES-256-CBC without authentication → AES-256-GCM with integrity verification. See `docs/target-architecture.md` §3.

4. **Master seed safety**: Remove the unconditional overwrite path. See `docs/initial-research.md` under shade-agent HIGH issues.

### Important (enables the use cases)

5. **Agent/service account auth**: Generate long-lived API keys for backend services, with rotation support. Agents should not use OAuth.

6. **Query layer**: Agents and auditors need to query the transaction log — "files by agent X," "files in time range Y," "membership changes in group Z." The on-chain contract stores this data but has no query API beyond "give me all transactions for group."

7. **Key rotation**: Group key versioning with re-wrapping on member revocation. Currently the primitives exist (group key versioning, revoke endpoint) but the re-wrapping logic is incomplete.

8. **Blob compression**: Reduce on-chain storage costs. See `docs/target-architecture.md` §5.2.

9. **Use React Query / remove unused deps**: The frontend wraps the entire app in `QueryClientProvider` with zero `useQuery` calls. Either implement proper data fetching or remove the dependency.

### Valuable (improves experience)

10. **Non-blocking agent startup**: The shade agent should serve health endpoints while waiting for whitelist registration, not block indefinitely.

11. **Circuit breaker on RPC calls**: Don't pile on retries when NEAR RPC is degraded. See `docs/target-architecture.md` §7.2.

12. **Fix the backwards network link**: Testnet badge links to mainnet and vice versa. `Header.tsx:54-55`.

13. **Fix Cache-Control**: Static assets (`/_next/static/*`) should be cached aggressively, not marked `no-store`. Current config applies `no-store` to everything.

14. **Structured logging with no PII**: Account IDs, emails, wallet IDs are logged to console across all services. Replace with structured logs and redact sensitive fields.

15. **DRY the shade agent**: Three separate copies of encrypt/decrypt, KV helpers, Borsh serialization, and RPC logic across route files. Extract to shared `lib/` modules.

16. **Remove the debug token endpoint**: `api/debug/token/route.ts` exposes raw Auth0 tokens.

17. **Remove the orphaned docs**: `docs/epics/001-tech-debt.md` and `docs/_template.md` reference technologies not in this codebase (better-auth, Sputnik DAO, oRPC, bun typecheck).

## Verdict

NOVA is a technically sound prototype with a genuinely differentiated primitive: verifiable, encrypted, shared storage. The architecture (client-side encryption + TEE key management + on-chain access logs) is well-chosen for the problem.

The product is currently unfocused. It presents as a consumer chat app when its real value is as infrastructure for auditable multi-party workflows. Narrowing to "verifiable, privacy-preserving shared storage for applications where access records must be audited by third parties" — and removing or properly rebuilding the AI layer — would make the value proposition clear.

The hackathon use case validates the model. The multi-agent collaboration pattern is a promising expansion. Both rely on the same primitives: encrypted upload, membership-gated access, tamper-proof audit trail. That's the product.

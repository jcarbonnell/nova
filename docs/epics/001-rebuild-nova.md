# Epic: Rebuild NOVA in the everything-dev Framework

## Goal

Condense `shade-agent` (TEE key management, crypto, NEAR KV storage) and `nova-landing` (Next.js UI) into the `nova-sdk.com` everything-dev monorepo. Implement the full three-tier key hierarchy and authenticated encryption from `docs/target-architecture.md`. Add structured access logging. Replace IPFS with data storage backed by PostgreSQL or NEAR KV.

## Motivation

The current system spans three services (shade-agent, mcp-server, nova-landing) with duplicated crypto, auth, and KV logic. The everything-dev framework already provides auth (better-auth), DB (Drizzle/PostgreSQL), and UI (React 19 + TanStack Router + Module Federation). Rebuilding NOVA as an every-plugin consolidates the codebase, fixes critical auth vulnerabilities (see `docs/initial-research.md`), and aligns with the long-term target architecture.

## Out of Scope

- Chat / MCP / AI agent integration
- TEE attestation verification (attestation stubs removed)
- Token-based agent authentication (not needed for MVP)
- NEAR smart contracts (existing contracts remain on-chain)

## Auth Strategy

**Drop Auth0.** Use the framework's native better-auth with NEAR SIWN (Sign In With NEAR), passkeys, organizations, and API keys. No email/social OAuth flow.

For wallet users:
1. Client requests a nonce: `GET /api/nova/auth/challenge?account_id=X`
2. Agent returns `{ nonce, timestamp }`
3. Client signs nonce with NEAR wallet
4. Client sends `POST /api/nova/auth/verify` with `{ account_id, nonce, signature, public_key }`
5. Agent verifies signature + key ownership → issues session (via better-auth)

## Architecture

```
nova-sdk.com (everything-dev monorepo)
├── api/src/                    # NOVA API plugin (every-plugin)
│   ├── contract.ts             # oRPC contract (full API surface)
│   ├── index.ts                # createPlugin with services
│   ├── db/
│   │   └── schema.ts           # upvotes + files + audit_events tables
│   └── lib/
│       ├── crypto.ts           # HKDF, AES-256-GCM, master seed
│       ├── auth.ts             # Auth middleware (extend existing)
│       ├── kv.ts               # NEAR KV read/write helpers
│       ├── rpc-gate.ts         # Circuit breaker + retry
│       └── logger.ts           # Structured logging
├── ui/src/                     # NOVA UI (TanStack Router)
│   ├── routes/
│   │   ├── _layout/
│   │   │   ├── index.tsx       # Landing page (nova-hero)
│   │   │   └── _authenticated/
│   │   │       ├── groups/     # Group CRUD pages
│   │   │       ├── files/      # File upload/retrieve
│   │   │       └── settings/   # Profile, API keys
│   └── components/
│       ├── nova-hero.tsx
│       ├── group-card.tsx
│       ├── file-upload.tsx
│       └── ...
└── bos.config.json             # Runtime config
```

## Tickets

| # | Ticket | Depends On |
|---|--------|------------|
| 1 | [API Contract & Crypto Foundation](#ticket-1) | — |
| 2 | [Key Hierarchy & Management](#ticket-2) | #1 |
| 3 | [Encrypted File Operations](#ticket-3) | #1, #2 |
| 4 | [Access Logging & Audit Trail](#ticket-4) | #1 |
| 5 | [UI Migration — Landing & Dashboard](#ticket-5) | #1, #3 |
| 6 | [Observability, Resilience & Cleanup](#ticket-6) | #1 |

Tickets 2, 3, and 4 can proceed in parallel after #1. Ticket 5 can start after contract is defined. Ticket 6 is ongoing.

# Epic: Rebuild NOVA

## Goal

Condense `shade-agent` (TEE key management, crypto, NEAR KV storage) and `nova-landing` (Next.js UI) into a single codebase. Implement the full three-tier key hierarchy and authenticated encryption from `docs/target-architecture.md`. Add structured access logging. Replace IPFS with data storage backed by PostgreSQL or FASTNEAR FastKV.

## Recommendations

- **everything-dev** (<https://github.com/NEARBuilders/everything-dev>) provides the monorepo framework (React 19 + TanStack Router + Module Federation UI, oRPC API, Drizzle/PostgreSQL). Rebuilding NOVA as an every-plugin gives us typed API contracts, hot-reload dev, and automatic deployment.
- **better-near-auth** (<https://github.com/elliotBraem/better-near-auth>) replaces Auth0 entirely. It handles NEAR wallet sign-in (SIWN), session management, API keys, and organizations out of the box — no custom challenge-response flow needed.

## Motivation

The current system spans three services (shade-agent, mcp-server, nova-landing) with duplicated crypto, auth, and KV logic. Rebuilding NOVA on everything-dev consolidates the codebase, fixes critical auth vulnerabilities (see `docs/initial-research.md`), and aligns with the long-term target architecture.

## Out of Scope

- Chat / MCP / AI agent integration
- Token-based agent authentication (not needed for MVP)
- NEAR smart contracts (existing contracts remain on-chain — agent-contract already supports local mode without TEE attestation)

## Auth Strategy

**Drop Auth0.** Use better-near-auth for NEAR wallet sign-in (SIWN), session management, API key generation, and organization membership. No email/social OAuth. No custom challenge-response — SIWN handles the full sign-with-nonce-and-verify flow.

## Architecture

```
nova-sdk.com (everything-dev monorepo)
├── api/src/                    # NOVA API plugin (every-plugin)
│   ├── contract.ts             # oRPC contract (full API surface)
│   ├── index.ts                # createPlugin with services
│   ├── db/
│   │   └── schema.ts           # files + audit_events + group_keys tables
│   └── lib/
│       ├── crypto.ts           # HKDF, AES-256-GCM, master seed
│       ├── kv.ts               # NEAR KV / FastKV read/write helpers
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
| 7 | [TEE Attestation (Phase 2)](#ticket-7) | #1, #2 |

Tickets 2, 3, and 4 can proceed in parallel after #1. Ticket 5 can start after contract is defined. Ticket 6 is ongoing. Ticket 7 is a stretch goal for Phala CVM deployment.

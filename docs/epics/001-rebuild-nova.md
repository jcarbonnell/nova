# Epic: Rebuild NOVA

## Goal

Condense `shade-agent` (TEE key management, crypto, NEAR KV storage) and `nova-landing` (Next.js UI) into a single codebase. Implement the full three-tier key hierarchy and AES-256-GCM authenticated encryption from `docs/target-architecture.md`. Add structured access logging with per-group retention policies. Replace IPFS with PostgreSQL blob storage (NEAR FastKV-swappable backend). All on-chain operations call the existing NEAR smart contracts — no new contracts needed.

## Framework Recommendations

- **everything-dev** (<https://github.com/NEARBuilders/everything-dev>) — monorepo framework with React 19 + TanStack Router + Module Federation UI, oRPC typed API contracts, Drizzle/PostgreSQL, hot-reload dev, and automated deployment.
- **better-near-auth** (<https://github.com/elliotBraem/better-near-auth>) — handles NEAR wallet sign-in (SIWN), session management, API keys with permission scoping, and organization membership. Replaces Auth0 entirely — no email/social OAuth, no custom challenge-response flow.

## Motivation

The current system spans three services (shade-agent, mcp-server, nova-landing) with duplicated crypto, auth, and KV logic across files. Rebuilding NOVA on everything-dev consolidates the codebase, fixes critical auth vulnerabilities (see `docs/initial-research.md`), upgrades to AES-256-GCM, and aligns with the long-term target architecture. The existing NEAR contracts (`nova-sdk.near` + `nova-kv.near`) remain operational — this rebuild is the API and UI layer on top of them.

## Out of Scope

- Chat / MCP / AI agent integration
- Token-based agent authentication (not needed with better-near-auth API keys)
- New smart contracts (existing contracts remain)

## Auth Strategy

**Drop Auth0.** Use better-near-auth for:
- NEAR wallet sign-in (SIWN) with proper signature verification
- Session management
- API keys (with permission scoping when needed)
- Organization membership (if needed later)

No custom nonce/challenge-response/verify flow — better-near-auth handles everything.

## Architecture

```
nova-sdk.com (everything-dev monorepo)
├── api/src/                    # NOVA API plugin (every-plugin)
│   ├── contract.ts             # oRPC contract (full API surface)
│   ├── index.ts                # createPlugin with services
│   ├── db/
│   │   └── schema.ts           # files + audit_events + group mirror tables
│   └── lib/
│       ├── crypto.ts           # HKDF, AES-256-GCM, master seed
│       ├── kv.ts               # NEAR KV read/write helpers
│       └── logger.ts           # Structured logging
├── ui/src/                     # NOVA UI (TanStack Router)
│   ├── routes/
│   │   ├── _layout/
│   │   │   ├── index.tsx       # Landing page (nova-hero)
│   │   │   └── _authenticated/
│   │   │       └── groups/     # Group CRUD + file management
│   └── components/
│       ├── nova-hero.tsx
│       ├── group-card.tsx
│       ├── file-upload.tsx
│       └── ...
└── bos.config.json             # Runtime config
```

## NEAR Contracts (existing, unchanged)

| Contract | Address | Purpose |
|---|---|---|
| Main | `nova-sdk.near` | Group membership, transaction recording, fee collection, TEE worker registration |
| KV | `nova-kv.near` | Encrypted blob storage (TEE-gated writes, public reads) |

Key methods used by the API:
- `register_group`, `get_owned_groups`, `get_member_groups`, `get_group_members`
- `is_authorized`, `get_group_owner`
- `add_group_member`, `revoke_group_member`
- `update_checksum`, `record_transaction`, `get_transactions_for_group`
- `kv.store`, `kv.get`
- `register_shade_worker`, `approve_shade_code_hash` (TEE — ticket #6)

## Tickets

| # | Ticket | Depends On |
|---|--------|------------|
| 1 | [API Contract, Crypto, Logging & Core Utilities](#ticket-1) | — |
| 2 | [UI Migration — Landing & Dashboard](#ticket-2) | #1 |
| 3 | [Key Hierarchy, Group Management & NEAR Integration](#ticket-3) | #1 |
| 4 | [Encrypted File Operations](#ticket-4) | #1, #3 |
| 5 | [Access Logging, Audit Trail & Retention](#ticket-5) | #1 |
| 6 | [TEE Attestation (Phase 2)](#ticket-6) | #1, #3 |

Ticket #1 defines the contract surface. Tickets #2, #3, #4, #5 can all proceed in parallel after #1 — the UI (#2) builds against contract types while the backend (#3, #4) implements the routes. Ticket #6 is a stretch goal for Phala CVM deployment.

### End State

Verifiable, end-to-end encrypted shared storage where access records are cryptographically auditable by third parties — every key retrieval, file operation, and membership change is logged and traceable per-group, with configurable data retention.

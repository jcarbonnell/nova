# NOVA MCP Server

The hosted Model Context Protocol (MCP) server that powers NOVA. It is the signing-and-orchestration layer between NOVA's clients (the SDKs, the `nova-ai-memory` plugin, the `nova-submit` tool) and NOVA's on-chain contracts, off-chain TEE key management (Shade Agent), and FastFS storage.

> **You probably don't call this directly.** Application developers use the [JavaScript SDK](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-js), the [Rust SDK](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-rs), the [`nova-ai-memory` Claude plugin](https://github.com/jcarbonnell/nova/tree/main/nova-ai-memory), or the [`@nova-sdk/contract`](https://github.com/jcarbonnell/nova/tree/main/api-contract) typed client — all of which wrap this server. This document describes what the server is, how it's deployed, and the tool surface it exposes.

## What it is

- A **hosted** FastMCP (Python, FastMCP v3+) server, deployed in a Phala TDX Confidential VM (CVM) alongside the Shade Agent — no centralized third-party hosting.
- Dual-network: mainnet (`nova-sdk.near`) and testnet (`nova-sdk-6.testnet`), selected per request from the caller's account.
- The signing proxy: clients never hold NEAR private keys. The server verifies a session token, retrieves the caller's key material from the Shade Agent's TEE (behind an internal auth gate), and signs the on-chain transaction on their behalf.

**Base URL (mainnet):**
```
https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network
```
The REST tool surface is at `/tools/*` (each tool is also registered as a FastMCP tool for MCP-protocol clients).

## Authentication

The server accepts a verified `nova_session` JWT as a Bearer token. There is **no** unauthenticated path and no private key ever crosses the client boundary.

1. A client exchanges its API key (`nova_sk_...`) for a short-lived session token at `https://nova-sdk.com/api/auth/session-token` (custom `X-API-Key` header).
2. The client calls `/tools/*` with `Authorization: Bearer <nova_session>`.
3. The server verifies the token (HS256, issuer + audience checked), extracts the caller's account, and cross-checks any `x-account-id` hint against the verified account — the hint is never trusted as identity.

The API key itself is obtained at [nova-sdk.com](https://nova-sdk.com) → *Manage Account*. Session tokens auto-refresh in the SDKs; the long-lived API key is rotatable.

## Architecture

```
        Client (SDK / plugin / api-contract)
                    │ Authorization: Bearer <nova_session>
                    ▼
        ┌───────────────────────────┐
        │      NOVA MCP Server       │
        │  (verify token → sign)     │
        └────┬───────────┬──────────┘
             │           │            │
     X-Internal-Auth     │            │
             ▼           ▼            ▼
     ┌────────────┐ ┌─────────┐ ┌──────────┐
     │ Shade Agent│ │  NEAR   │ │  FastFS  │
     │   (TEE)    │ │contract │ │(on NEAR) │
     │ key ops    │ │ access  │ │ ciphertext│
     └────────────┘ └─────────┘ └──────────┘
      keys never     nova-sdk.near   durability
      leave the TEE  nova-kv.near    rooted in
                     (enc. blobs)    NEAR history
```

The server runs in the same CVM as the Shade Agent and reaches it over the internal network behind an `X-Internal-Auth` shared secret. All symmetric encryption is **AES-256-GCM**; keys are derived in the TEE and stored as encrypted blobs on `nova-kv.near`, never in plaintext on-chain.

## Storage

New uploads use **FastFS** (file bytes flow through NEAR receipts; durability is the chain, the gateway is swappable). Legacy files previously stored on IPFS remain retrievable transparently — the retrieve path dispatches on the stored reference (a FastFS location vs a legacy IPFS CID). There is no IPFS upload path.

## Tool surface

The server exposes these `/tools/*` operations. The canonical, typed description of the public surface — with input/output schemas verified against the live server — is the [`@nova-sdk/contract`](https://github.com/jcarbonnell/nova/tree/main/api-contract) package.

### File operations

- **`prepare_upload`** — returns a per-file encryption key (wrapped under the group key, from the TEE) and an `upload_id`. The client encrypts locally.
- **`finalize_upload`** — accepts the client's ciphertext + format, writes it to FastFS, and records the transaction on-chain (`backend=FastFS`).
- **`prepare_retrieve`** — returns the per-file key + ciphertext + format for an authorized member to decrypt locally (legacy IPFS files served transparently).

### Group management

- **`register_group`** — create a group (caller becomes owner); triggers Shade group-key generation.
- **`add_group_member`** / **`revoke_group_member`** — manage membership; revoke rotates the group key off-chain in the TEE.
- **`set_group_retention`** — set/clear a per-group retention window (owner-gated).
- **`join_group`** — self-join an open group (the caller joins themselves).
- **`create_hackathon_group`** / **`close_hackathon_join`** — one-call "deploy event" (register joinable + generate key + open join window) and manual early-close.

### Queries

- **`get_owned_groups`** / **`get_member_groups`** — the caller's groups (reader-gated account views).
- **`get_group_members`** / **`get_group_transactions`** — a group's members / file audit trail (joinable groups use free public views; private groups use the signed, authorized path).
- **`auth_status`** — authentication + group-authorization check.

## Encryption model

Encryption and decryption are **client-side**, in the SDKs — the MCP server never sees plaintext. The server returns keys and ciphertext; the byte-sensitive operations run in the client (SDK, plugin, or WASM tool), which is what keeps plaintext and keys from ever traveling together. This separation is deliberate: byte-exact crypto driven by an LLM is not stable, so it stays in compiled, deterministic client code.

## Security considerations

1. **No private keys client-side** — the server signs on the caller's behalf using TEE-held key material; clients hold only a session token.
2. **Fails closed** — a missing or invalid session token is rejected; there is no header-only fallback.
3. **TEE key custody** — encryption keys are derived and held in the Shade Agent's TEE, stored only as GCM-encrypted blobs on `nova-kv.near`, never on-chain in plaintext.
4. **Internal gate** — the server↔Shade path is protected by `X-Internal-Auth`; health checks are exempt.
5. **Attestation** — key operations are backed by TEE attestation; group checksums are verifiable on-chain.

## Deployment

The server ships as a Docker image (`jcarbonnell/nova-mcp`) and runs in the Phala CVM via `docker-compose`, alongside the Shade Agent image. It has no external database — all state is on-chain (the NOVA contract and `nova-kv.near`) or in the TEE. Configuration is entirely environment-driven (contract IDs, RPC URLs, session-token issuer/audience/secret, the internal auth secret, the FastNear API key, the reader key). No secrets are hardcoded.

## Resources

- [NOVA Documentation](https://civictech-ou.gitbook.io/nova-docs/)
- [`@nova-sdk/contract`](https://github.com/jcarbonnell/nova/tree/main/api-contract) — typed client + the canonical tool surface
- [JavaScript SDK](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-js) · [Rust SDK](https://github.com/jcarbonnell/nova/tree/main/nova-sdk-rs) · [Claude plugin](https://github.com/jcarbonnell/nova/tree/main/nova-ai-memory)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [NEAR Protocol](https://near.org) · [FastFS](https://fastfs.io) · [Phala TEE](https://phala.com)

## Support

- Issues: [GitHub Issues](https://github.com/jcarbonnell/nova/issues)
- Discussions: [GitHub Discussions](https://github.com/jcarbonnell/nova/discussions)

## License

MIT — Copyright (c) 2026 CivicTech OÜ
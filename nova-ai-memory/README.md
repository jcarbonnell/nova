# NOVA plugin — "NOVA inside your own agent"

A local [MCP](https://modelcontextprotocol.io) plugin that exposes NOVA's
verifiable, privacy-preserving storage primitive as tools your agent can call
natively — in **Claude Code** and **Codex**. Store, retrieve, and manage
encrypted files on NEAR using only an API key. No wallet, no NEAR knowledge, no
blockchain surface.

Get an API key at [nova-sdk.com](https://nova-sdk.com) → *Manage Account*.

## Status

**B1 skeleton.** The plugin loads and its stdio MCP server starts and exposes a
single liveness tool (`nova_ping`). Real NOVA tools (list / store / retrieve /
group management) arrive in subsequent build steps.

## How it works

The plugin bundles a local stdio MCP server (`server/index.js`) that wraps
[`nova-sdk-js`](https://www.npmjs.com/package/nova-sdk-js). Each tool call maps
to an SDK method; the SDK handles session-token minting, client-side encryption,
and the on-chain calls. The server holds only your API key (from the
environment) — never a private key, never plaintext-and-key together.

The server is **credential-agnostic**: it reads `NOVA_*` from its environment and
does not care how the host populated it. This is what lets one server serve both
Claude Code and Codex unchanged.

### Configuration (environment)

| Variable | Required | Meaning |
|---|---|---|
| `NOVA_API_KEY` | yes | Your NOVA API key (`nova_sk_…`). |
| `NOVA_ACCOUNT_ID` | yes | Your NOVA account (e.g. `alice.nova-sdk.near`). |
| `NOVA_MCP_URL` | no | Override the hosted MCP URL (defaults to production). |
| `NOVA_AUTH_URL` | no | Override the session-token origin (`nova-sdk.com`). |
| `NOVA_RPC_URL` | no | Override the NEAR RPC endpoint. |
| `NOVA_CONTRACT_ID` | no | Override the NOVA contract (mainnet default). |

How these are supplied differs per host (Claude Code prompts for and stores them;
Codex uses its own mechanism) — the server behaves identically either way.

## License

MIT — Copyright (c) 2026 CivicTech OÜ

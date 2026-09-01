# nova-ai-memory — NOVA inside your own agent

A [Claude Code](https://code.claude.com) plugin that gives your agent a
persistent, verifiable, privacy-preserving memory: store, retrieve, and manage
end-to-end-encrypted files on [NOVA](https://nova-sdk.com) using only an API key.
No wallet, no NEAR knowledge, no blockchain surface — the chain is an
implementation detail.

NOVA is verifiable, privacy-preserving shared storage on the NEAR blockchain:
data is encrypted so only authorized group members can read it, multiple parties
can share the same encrypted data, and every access is independently auditable
on-chain. This plugin embeds that primitive directly in your agent.

> **Get started:** create an account and generate an API key at
> [nova-sdk.com](https://nova-sdk.com) → *Manage Account* → *Show My API Key*.

## Install

/plugin marketplace add anthropics/claude-plugins-community
/plugin install nova-ai-memory@claude-community


On install you'll be asked for two values, stored securely by Claude Code:

- **NOVA Account ID** — e.g. `alice.nova-sdk.near`
- **NOVA API Key** — starts with `nova_sk_` (kept in your OS keychain; never shown in logs)

That's the entire setup. No wallet, no seed phrase, no RPC configuration.

## What you can do

Once installed, ask Claude naturally — it will call these tools:

| Tool | What it does | Cost |
|---|---|---|
| `list_owned_groups` | List groups you own | free |
| `list_member_groups` | List groups you belong to | free |
| `list_group_files` | List a group's files (its on-chain audit trail) | free for open groups; ~0.0013 NEAR for private |
| `store_file` | Encrypt and store a file in a group | ~0.003 NEAR |
| `retrieve_file` | Retrieve and decrypt a file | ~0.001 NEAR |
| `register_group` | Create a new group (you become owner) | ~0.05 NEAR |
| `add_group_member` | Grant another account access to a group | ~0.001 NEAR |
| `revoke_group_member` | Remove a member and rotate the group key | ~0.001 NEAR |
| `join_group` | Self-join an open group (e.g. a hackathon) | ~0.001 NEAR |

A **group** is a container for shared encrypted files with fine-grained
membership. Files are encrypted client-side (AES-256-GCM) before they ever leave
your machine — NOVA stores ciphertext and never sees your plaintext or your keys.

Operations that write to the chain cost small amounts of real NEAR, paid from
your NOVA account balance. The tool descriptions state each cost so the agent can
tell you before spending. Read operations on your own groups are free.

### Examples

- *"Which NOVA groups do I own?"*
- *"Store these meeting notes in my `team-files` group."*
- *"List the files in `team-files` and retrieve the latest one."*
- *"Add `bob.nova-sdk.near` to `team-files`."*

Files cross the tool boundary as base64, so **any** file type works — text,
images, PDFs, binary. Maximum ~4 MB per file. For text, the agent base64-encodes
it for you; `retrieve_file` returns a text preview when the content is UTF-8.

## How it works

The plugin bundles a local [MCP](https://modelcontextprotocol.io) server
(`server/index.js`) that wraps
[`nova-sdk-js`](https://www.npmjs.com/package/nova-sdk-js). Each tool call maps to
an SDK method; the SDK mints a short-lived session token from your API key,
performs client-side encryption/decryption, and makes the on-chain calls.

Claude Code ──stdio MCP──▶ nova-ai-memory server ──▶ nova-sdk-js ──▶ NOVA (MCP + NEAR)
(this plugin) (encryption, (storage,
session token) access control)


### What it accesses

- **Network:** `nova-sdk.com` (to exchange your API key for a session token) and
  NOVA's hosted MCP endpoint (for storage/retrieval and on-chain operations).
- **Credentials:** your `NOVA_API_KEY` and `NOVA_ACCOUNT_ID`, read from the
  environment Claude Code provides. The plugin holds only these — **never** a NEAR
  private key. Keys are managed inside NOVA's TEE and never reach the plugin.
- **No filesystem, shell, or hook access.** The plugin contributes MCP tools
  only: no hooks, no slash commands that run shell, no file-system writes outside
  what you explicitly ask it to store in NOVA.

### Security

- Files are encrypted client-side; plaintext and keys never travel together, and
  NOVA never sees either.
- The API key and session token are never written to any log (the server routes
  all diagnostic output to stderr and reports the key only as `present`/`unset`).
- Session tokens are short-lived and refreshed automatically by the SDK; the
  long-lived API key can be rotated any time at nova-sdk.com.

## Configuration (environment)

Claude Code populates these from the values you enter at install; you normally
never set them by hand. They're documented here for transparency and for
non-Claude-Code hosts.

| Variable | Required | Meaning |
|---|---|---|
| `NOVA_API_KEY` | yes | Your NOVA API key (`nova_sk_…`). |
| `NOVA_ACCOUNT_ID` | yes | Your NOVA account (e.g. `alice.nova-sdk.near`). |
| `NOVA_MCP_URL` | no | Override the hosted MCP URL (defaults to production). |
| `NOVA_AUTH_URL` | no | Override the session-token origin (`nova-sdk.com`). |
| `NOVA_RPC_URL` | no | Override the NEAR RPC endpoint. |
| `NOVA_CONTRACT_ID` | no | Override the NOVA contract (mainnet default). |

The server is **credential-agnostic**: it reads `NOVA_*` from its environment and
doesn't care how the host set them. This is what lets one server work across
different MCP hosts unchanged.

## Requirements

- Node.js ≥ 22 (the server runs on Node; Claude Code installs the plugin's
  dependencies from the committed lockfile at install time).
- A funded NOVA account for write operations. Read operations on your own groups
  are free.

## Costs

NOVA runs on NEAR **mainnet** by default — write operations consume real NEAR
from your account balance (see the table above). Ensure your account is funded
before storing files or managing groups. Retrieval and listing your own groups
are effectively free.

## Codex

The server is a standard stdio MCP server, so it is portable to
[Codex](https://developers.openai.com/codex) with a Codex-side manifest. Codex
support is a planned follow-up; this release targets Claude Code.

## Development

To work on the plugin locally:

```bash
git clone https://github.com/jcarbonnell/nova
cd nova/nova-ai-memory
npm install
```

Load it into Claude Code for a dev session:

```bash
claude --plugin-dir /path/to/nova/nova-ai-memory
```

> **Dev note — credentials under `--plugin-dir`:** a `--plugin-dir` dev session
> does **not** run the install-time credential prompt, so `${user_config.*}`
> won't be populated. For local development, set `NOVA_API_KEY` and
> `NOVA_ACCOUNT_ID` in your shell environment (or a `.env` file with
> `node --env-file`) and exercise the server directly over stdio. The full
> credential path (prompt → keychain → substitution) only runs on a real
> marketplace install.

> **Dev note — stdout is the protocol channel:** an stdio MCP server must write
> **only** JSON-RPC to stdout. The server redirects all `console.*` output
> (including the SDK's) to stderr at startup — do not remove that redirect, or
> library logging will corrupt the protocol stream and the client will drop the
> connection.

## Links

- NOVA: [nova-sdk.com](https://nova-sdk.com)
- SDK: [`nova-sdk-js`](https://www.npmjs.com/package/nova-sdk-js)
- Docs: [nova-25.gitbook.io/nova-docs](https://nova-25.gitbook.io/nova-docs/)
- Source: [github.com/jcarbonnell/nova](https://github.com/jcarbonnell/nova)

## License

MIT — Copyright (c) 2026 CivicTech OÜ
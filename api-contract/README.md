# @nova-sdk/contract

A typed, contract-first description of NOVA's **public wire protocol** — the
`POST /tools/*` operations served by the NOVA MCP server. One package gives you:

- **the contract** — an [oRPC](https://orpc.dev) contract describing all eleven
  operations, their inputs, and their response shapes;
- **a typed client** — `createNovaClient(...)`, so you call NOVA with full type
  inference and no hand-written fetch;
- **an OpenAPI spec** — `openapi.json`, generated from the contract.

The contract is an *honest* description: every operation is verified against the
live server by `test/harness.mjs`, which calls real MCP and validates the real
responses against the contract's schemas.

## Install

```bash
npm install @nova-sdk/contract
```

## Consumer pathway (step by step)

### 1. Get a NOVA account and an API key

Sign in at [nova-sdk.com](https://nova-sdk.com) (email, Google, or GitHub) and
generate an API key (`nova_sk_...`) for your account.

### 2. Turn the API key into a session token

This package speaks only the MCP `/tools/*` surface — it does **not** mint
tokens. Exchange your API key for a short-lived `nova_session` token via the
NOVA auth endpoint:

```bash
curl -X POST https://nova-sdk.com/api/auth/session-token \
  -H "Content-Type: application/json" \
  -H "X-API-Key: nova_sk_your_key" \
  -d '{"account_id": "you.nova-sdk.near"}'
# → { "token": "eyJ...", "account_id": "...", "expires_in": "24h" }
```

Token lifecycle (refresh on expiry) lives in *your* code, not here — see the
note on the `token` getter below.

### 3. Create a client and call NOVA

```ts
import { createNovaClient } from '@nova-sdk/contract';

const nova = createNovaClient({
  token: process.env.NOVA_SESSION_TOKEN!, // the token from step 2
});

// List the groups your account owns
const { result: owned } = await nova.getOwnedGroups({});

// Register a group (you become its owner)
await nova.registerGroup({ group_id: 'my-group' });

// Upload a file, end-to-end encrypted:
const up = await nova.prepareUpload({ group_id: 'my-group', filename: 'doc.pdf' });
// up.result.key is the base64 AES-256 GROUP key — encrypt client-side with it,
// then finalize:
await nova.finalizeUpload({
  upload_id: up.result.upload_id,
  encrypted_data,          // your base64 IV|ciphertext|tag
  file_hash,               // 64-char hex SHA-256 of the plaintext
});
```

### Auto-refreshing tokens

`token` accepts either a string or an async getter, so an API-key→token flow can
live outside this package and refresh transparently:

```ts
const nova = createNovaClient({
  token: async () => await getFreshSessionToken(myApiKey),
});
```

## Operations

| Method | Wire endpoint | Notes |
| --- | --- | --- |
| `getOwnedGroups` | `POST /tools/get_owned_groups` | read-only |
| `getMemberGroups` | `POST /tools/get_member_groups` | read-only |
| `getGroupMembers` | `POST /tools/get_group_members` | requires group authorization |
| `getGroupTransactions` | `POST /tools/get_group_transactions` | audit trail |
| `authStatus` | `POST /tools/auth_status` | read-only |
| `registerGroup` | `POST /tools/register_group` | mutating; caller becomes owner |
| `addGroupMember` | `POST /tools/add_group_member` | mutating |
| `revokeGroupMember` | `POST /tools/revoke_group_member` | mutating; **currently server-blocked** (see below) |
| `prepareUpload` | `POST /tools/prepare_upload` | returns the group key |
| `finalizeUpload` | `POST /tools/finalize_upload` | records the transaction on-chain |
| `prepareRetrieve` | `POST /tools/prepare_retrieve` | returns the group key |

Every success response is wrapped in `{ "result": ... }` — the contract and
client describe that envelope faithfully.

## Notes on honesty

- **`revoke_group_member`** is described but not yet confirmed against a `200`:
  the live endpoint currently returns a server-side `500`. The contract entry is
  the intended success shape; it will be confirmed once the server issue is
  resolved.
- **The OpenAPI spec documents success (`200`) responses only.** Error responses
  (`401`/`403`/`404`/`500`) are intentionally not yet described.

## Security

`prepare_upload` and `prepare_retrieve` return a base64 **group** key so an
authorized member can encrypt/decrypt client-side. This is by design. A NEAR
**private** key never appears on this surface, and the spec generator fails the
build if the string `private_key` ever appears in the emitted spec.

## Development

```bash
npm run build      # compile the contract + client to dist/
npm run openapi    # regenerate openapi.json from the contract
NOVA_SESSION_TOKEN=eyJ... npm run harness            # verify contract vs live MCP (read-only + client)
NOVA_SESSION_TOKEN=eyJ... npm run harness -- --write # + mutating sweep (spends NEAR)
```

## License

MIT
# nova-agent-connect

Give your **NEAR Intents Agent API ("Agent Connect")** agent private, verifiable storage on
[NOVA](https://nova-sdk.com), with **no custodian**. The agent signs in to NOVA as its own NEAR account
and signs and pays its own NOVA writes with that account. NOVA never signs for it, sponsors none of its
transactions, and never sees its keys or its plaintext.

```
your backend (holds naa_ + ngt_)                    NOVA (MCP + TEE)                    NEAR
  connectNovaAgent ──── native/near/sign-message ──► verify NEP-413 ─► nova_session
  nova.upload ───────── prepare_upload ────────────► per-file key + location
     encrypt locally
     native/near/call record_transaction ───────────────────────────────────────────► signed by the agent
     finalize_upload(tx_hash) ─────────────────────► checks the tx on chain, then stores ciphertext
  nova.retrieve ─────── prepare_retrieve ──────────► key released to on-chain members only
     decrypt locally, compare sha256 with the on-chain file_hash
```

Live on mainnet since 2026-10-29 (smoke 17/17: sign-in, upload, retrieve, on-chain row, self-join, and
every refusal below).

## What you need

- An Agent Connect agent with an owner (any owner wallet type), a live grant (`ngt_…`) and your partner
  API key (`naa_…`), both in your backend.
- Node 24+ and an ESM backend (the Agent API SDK is ESM-only).
- `nova-sdk-js@1.4.0` and `@near-intents-agent-api/sdk@0.7.2` (the versions this module is tested against).
- A NOVA group the agent can use: one your custodial NOVA account owns and adds the agent to, or a
  joinable group with an open window.

## 1. The owner allows NOVA (once, one signature)

Policies are always sent complete. `novaPolicyPatch` returns the owner's current policy plus exactly
what NOVA needs; it never turns on `native.near.transfer`, EVM or Solana signing, and leaves every other
field unchanged.

```ts
import { createAgentApi } from '@near-intents-agent-api/sdk';
import { novaPolicyPatch } from './nova-agent-connect.ts';

const api = createAgentApi({ apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY!, baseUrl: process.env.NEAR_INTENTS_AGENT_API_URL });
const view = await api.getPolicy(agentId);
const policy = novaPolicyPatch(view.policy!, { maxDepositYocto: 10n ** 22n }); // 0.01 NEAR per call
const intent = await api.generateIntent({ type: 'policy_update', agent_id: agentId, policy, expected_revision: view.revision! });
// Show intent.preview.summary to the owner; their wallet signs intent.intent.payload unchanged;
// submitIntent; wait until the policy is APPLIED and provider_policy_synced.
```

What it adds, and why:

| Field | Value | Why |
|---|---|---|
| `native.near.sign_message` | `["nova-sdk.near"]` | sign in to NOVA (NEP-413) |
| `native.near.call` | `["nova-sdk.near"]` | sign NOVA writes; no other contract is callable |
| `assets` | `+ "nep141:wrap.near"` | native NEAR deposits are counted as wNEAR |
| `limits.per_transaction["nep141:wrap.near"]` | your cap | bounds each call's deposit |

Also check **`max_actions_per_hour`**: every NOVA write that reaches the chain is one action, even one the
contract refuses (observed: a fixed UTC clock hour; policy refusals and sign-ins do not count). Set it to
the writes you expect plus headroom.

Native calls skip `destinations`, `budget`, `timelock_ms`, `schedule` and `owner_approval`. That is why
the call list names only `nova-sdk.near` and the deposit cap stays small. A call's deposit is NOVA's fee
for that action: read it with `estimate_fee({"action": "<method>"})` on `nova-sdk.near` before you pick
the cap. 0.01 NEAR covered every write in the live smoke (`record_transaction` 0.0000256 NEAR, `join_group`);
`register_group` is 0.64 NEAR (see Limits). The module refuses locally, sending nothing, any deposit above
`maxDepositYocto`.

## 2. Fund the agent's NEAR account

The agent pays its own gas and fees from `wallet.near_account_id` (an implicit account; any NEAR
transfer creates it). 0.1 NEAR is plenty to start: an upload costs it about 0.0004 NEAR.

```bash
near send-near <your-account> <agent wallet.near_account_id> 0.1 --networkId mainnet
```

## 3. Connect, then use plain nova-sdk-js

```ts
import { connectNovaAgent } from './nova-agent-connect.ts';

const agentApi = api.forGrant(grantToken);                 // one client per agent/session
const { nova, signer } = await connectNovaAgent(agentApi, agentId, { store, maxDepositYocto: 10n ** 22n });
await signer.resolvePending();                             // settle a write a crash left open, if any

const up = await nova.upload('acme-proofs', bytes, 'order-123.json');  // signed + paid by the agent
const { data } = await nova.retrieve('acme-proofs', up.cid);
await nova.joinGroup('event-submissions');                 // self-join an open joinable group
```

`nova` is an ordinary `NovaSdk` in wallet mode (`nova.signerMode === 'wallet'`): every method works as
documented in [nova-sdk-js](https://www.npmjs.com/package/nova-sdk-js); writes go through the agent's own
signature. Verify what you retrieve: `sha256(data)` must equal the `file_hash` recorded on chain.

The NOVA session is a short-lived token (`sessionExpiresIn`): call `connectNovaAgent` again when the SDK
reports it expired.

## 4. Keep writes safe across crashes: the `store`

Each NOVA write is one Agent API native call. Its idempotency key and body are saved in `store` before
the request is sent; while a call may have been sent, every new write refuses until it is settled.

```ts
const store: PendingStore = {                          // one row per agent in your DB
  load: async () => db.get(`nova-pending:${agentId}`),
  save: async (p) => db.put(`nova-pending:${agentId}`, p),
  clear: async () => db.del(`nova-pending:${agentId}`),
};
```

`memoryStore()` exists for tests and scripts only: it is lost on restart. The stored call holds no secret.

| What happened | What the module does | What you do |
|---|---|---|
| `SUCCESS` | returns the transaction hash; clears the store | nothing |
| policy or request refusal (403, 409, non-retryable 4xx) | throws `Agent API refused …: <status> <code> [<layer>]`; clears the store (nothing was sent) | fix the cause (policy, balance, cap) |
| 429 / `provider_rate_limited` / 5xx / transport error / `UNCERTAIN` | throws `NativeCallPendingError`; keeps the call | later: `signer.resolvePending()` (replays the same key and body, or polls the same id) |
| `NEEDS_REVIEW` | throws `NativeCallPendingError`; keeps the call | stop and inspect; do not retry |
| contract panic | throws `… ended FAILED (native_request_failed): <panic text>`; clears the store | fix the request |

If `resolvePending()` reports `SUCCESS` for an upload whose finalize never ran, the record is on chain
without bytes; the NOVA console labels it "record without bytes".

## Refusals you can expect (observed on mainnet)

| Layer | Request | Answer |
|---|---|---|
| this module (nothing sent) | another contract, a non-NOVA method, a deposit above `maxDepositYocto`, a new write while one is pending | `refusing: …` / `… is pending: call resolvePending() first` |
| Agent API | a contract not in `native.near.call` | `403 native_method_denied` |
| Agent API (provider) | a deposit above the owner's cap, or the hourly action budget used up | `409 policy_denied` |
| NOVA MCP | a `tx_hash` that is not this upload's record (another account's, or your own earlier one) | refused before any byte is stored |
| NOVA contract | an owner operation on a group the agent does not own | `FAILED (native_request_failed): … Only group owner can add` |

## What NOVA can and cannot see

- NOVA's servers see ciphertext and on-chain metadata only; the TEE holds keys, not files, and releases a
  key only to an on-chain member. Group ids, members, file hashes and timestamps are public on NEAR.
- `naa_…`, `ngt_…` and the NOVA session never leave your backend: never put them in a browser, a URL, a
  log or a model prompt. This module sends `naa_`/`ngt_` only to the Agent API client you pass, never to NOVA.
- Whatever model you hand plaintext to sees it; NOVA's guarantee ends there.

## Limits

- **Owner operations by an agent** need a group the agent owns. `register_group` costs 0.64 NEAR, so the
  owner's per-transaction cap must allow it; this path is supported by the same code but not yet proven
  live for agents. The common pattern: your custodial NOVA account (backend, `nova_sk_` API key) owns
  and administers the group; agents sign in as themselves, read, and upload with their own signature.
- **Access windows** (`accessMinutes`, "sell a window, not a copy") need a custodial owner: NOVA's
  scheduler revokes by signing as the owner, and NOVA never signs for a self-custodial account.
- One write at a time per agent (the pending-call rule).

## Patterns

- **Paid proof handoff (e.g. LoadWallet).** The payer agent uploads each proof itself into a group your
  backend owns; the verifier agent signs in, checks the on-chain `file_hash`, retrieves, then pays.
  Every upload is attributed on chain to the agent that made it.
- **Data market (e.g. Datagent).** Your custodial account owns one group per capsule and sells
  access windows; buyer agents sign in, read, and can write back (receipts, reviews) with their own signature.
- **Event submissions.** A joinable group with an open window; each agent self-joins and uploads its entry.

## Verify this module yourself

```bash
npm i -E nova-sdk-js@1.4.0 @near-intents-agent-api/sdk@0.7.2 && npm i -D -E typescript@5.6.3 tsx@4.19.2 @types/node@22
npx tsc -p .                          # strict, no skipLibCheck
npx tsx test-nova-agent-connect.ts    # 43 offline checks (Agent API and NOVA mocked behind fetch)
node mutate-nova-agent-connect.mjs    # 17 mutants, each breaking one guarantee: all must be caught
```

## Links

- [NOVA llms.txt](https://nova-sdk.com/llms.txt): the whole API for agents and integrators
- [nova-sdk-js](https://www.npmjs.com/package/nova-sdk-js) · [NOVA console](https://nova-sdk.com/app)
- [Agent API native accounts](https://github.com/NEAR-Intents-Agent-API/skills/blob/main/near-intents-agent-api/references/policy.md) · [Agent API SDK](https://github.com/NEAR-Intents-Agent-API/sdk-typescript)
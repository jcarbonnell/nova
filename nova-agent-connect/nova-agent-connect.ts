/**
 * nova-agent-connect.ts: NOVA for NEAR Intents Agent API ("Agent Connect") agents, self-custodial.
 *
 * Reference module (copy it into your ESM backend; the Agent API SDK is ESM-only, Node 24+).
 * Typechecked against nova-sdk-js 1.4.0 and
 * @near-intents-agent-api/sdk 0.7.2. No new dependency: you pass the Agent API client you already use.
 *
 * What it gives you
 *   - The agent signs and pays its own NOVA writes from its own NEAR account, through
 *     Agent API `native/near/call`. NOVA never signs for it, sponsors nothing, and never sees a key.
 *   - The agent signs in to NOVA as itself (`native/near/sign-message`, NEP-413).
 *   - Everything else is plain nova-sdk-js: `connectNovaAgent()` returns a ready `NovaSdk`.
 *
 *     import { createAgentApi } from '@near-intents-agent-api/sdk';
 *     import { connectNovaAgent, novaPolicyPatch } from './nova-agent-connect';
 *
 *     // Once, by the owner (their wallet signs, as for any policy change):
 *     const view = await api.getPolicy(agentId);
 *     const policy = novaPolicyPatch(view.policy!, { maxDepositYocto: 10n ** 22n });   // 0.01 NEAR
 *     await api.generateIntent({ type: 'policy_update', agent_id: agentId, policy, expected_revision: view.revision! });
 *     // … owner signs intent.payload, submitIntent, wait for APPLIED + provider_policy_synced.
 *     // Then send a little NEAR to the agent's `wallet.near_account_id` (it pays its own gas).
 *
 *     // Per session, in your backend:
 *     const agentApi = createAgentApi({ apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY!, baseUrl }).forGrant(grantToken);
 *     const { nova, signer } = await connectNovaAgent(agentApi, agentId, { store, maxDepositYocto: 10n ** 22n });
 *     await signer.resolvePending();                           // settle a write left by a crash, if any
 *     await nova.upload('my-group', bytes, 'proof.json');   // signed + paid by the agent
 *     await nova.retrieve('my-group', location);
 *
 * Rules (from the Agent API and NOVA)
 *   - `naa_…` and `ngt_…` stay in your backend: this module never forwards them anywhere but the
 *     Agent API client you pass, and never to NOVA, a browser, a model prompt or a log.
 *   - The owner's policy decides what the agent may sign: `native.near.call` must list the NOVA
 *     contract; native NEAR deposits count as wNEAR, so `assets` must allow `nep141:wrap.near` and
 *     `limits.per_transaction` caps each deposit. Native calls skip destinations, budget, timelock,
 *     schedule and owner approval; `max_actions_per_hour` still counts them: every NOVA write that
 *     reaches the chain is one action, even one the contract refuses (observed 2026-10-29: a fixed
 *     UTC clock hour; policy refusals and sign-ins are not counted). Set it to the agent's expected
 *     writes plus headroom. `provider_rate_limited` is retryable: the call stays pending and
 *     `resolvePending()` replays it under the same key.
 *   - One NOVA write = one native call. Its idempotency key and body are saved BEFORE sending
 *     (`store`). A call that may have been sent blocks the next one until `resolvePending()` has
 *     settled it: never resend it under a new key.
 *
 * Limits
 *   - Owner operations need a group the agent owns; `register_group` costs 0.64 NEAR (fee), so the
 *     owner's per-transaction cap must allow it. Access windows (`accessMinutes`) stay custodial-only.
 *   - A NOVA session is a short-lived token: call `connectNovaAgent()` again when the SDK reports it expired.
 */

import { NovaSdk } from 'nova-sdk-js';
import type { NovaSdkConfig, NovaWalletSigner, WalletFunctionCall } from 'nova-sdk-js';
import {
  AgentApiError,
  type AgentApi,
  type Policy,
  type StatusResponse,
} from '@near-intents-agent-api/sdk';

export const NOVA_CONTRACT_ID = 'nova-sdk.near';
export const NOVA_URL = 'https://nova-sdk.com';
const WNEAR = 'nep141:wrap.near';

/** The contract methods nova-sdk-js signs in wallet mode. Nothing else is ever sent. */
export const NOVA_WRITE_METHODS = [
  'record_transaction',
  'register_group',
  'add_group_member',
  'revoke_group_member',
  'set_group_retention',
  'join_group',
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Owner side: the policy additions NOVA needs
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface NovaPolicyOptions {
  /** Cap on each call's attached NEAR, in yoctoNEAR (wNEAR `limits.per_transaction`). */
  maxDepositYocto: bigint;
  contractId?: string;
}

/**
 * The owner's COMPLETE policy with NOVA's additions, ready for `policy_update` (policies are always
 * sent complete). Adds the NOVA contract to `native.near.sign_message` (sign-in) and
 * `native.near.call` (writes), allows wNEAR in `assets`, and sets its per-transaction cap. Every
 * other field is returned unchanged; `native.near.transfer` and the EVM/Solana switches are never
 * turned on. The input is not modified.
 */
export function novaPolicyPatch(policy: Policy, opts: NovaPolicyOptions): Policy {
  const contract = opts.contractId ?? NOVA_CONTRACT_ID;
  if (opts.maxDepositYocto <= 0n) throw new Error('maxDepositYocto must be > 0');
  const next: Policy = structuredClone(policy);
  const native = next.native ?? {
    near: { sign_message: [], transfer: false, call: [] },
    evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
    solana: { sign_message: false, sign_transaction: false },
  };
  if (!native.near.sign_message.includes(contract)) native.near.sign_message.push(contract);
  if (!native.near.call.includes(contract)) native.near.call.push(contract);
  next.native = native;
  if (next.assets !== 'any' && !next.assets.includes(WNEAR)) next.assets.push(WNEAR);
  next.limits = { ...next.limits, per_transaction: { ...(next.limits.per_transaction ?? {}), [WNEAR]: opts.maxDepositYocto.toString() } };
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sign-in: the agent proves its NEAR account to NOVA (NEP-413 via native/near/sign-message)
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface NovaSession {
  token: string;
  accountId: string;
  expiresIn?: number;
}

/** `api` must be a grant client (`api.forGrant(token)`); the owner's policy must list the NOVA
 * contract in `native.near.sign_message`. The NOVA session is a secret: keep it in your backend. */
export async function signInAgent(
  api: AgentApi,
  agentId: string,
  opts: { novaUrl?: string; fetch?: typeof fetch } = {},
): Promise<NovaSession> {
  const base = (opts.novaUrl ?? NOVA_URL).replace(/\/$/, '');
  const f = opts.fetch ?? fetch;
  const post = async (path: string, body: unknown) => {
    const r = await f(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, any>;
    if (!r.ok) throw new Error(`NOVA ${path} refused: ${r.status} ${data.code ?? data.error ?? ''}`.trim());
    return data;
  };

  const ch = await post('/api/auth/agent-identity/challenge', {});
  if (typeof ch.nonce !== 'string' || typeof ch.message !== 'string' || typeof ch.audience !== 'string') {
    throw new Error('NOVA challenge is missing message, audience or nonce');
  }
  const sig = await api.nativeNearSignMessage(agentId, { message: ch.message, recipient: ch.audience, nonce: ch.nonce });
  const v = await post('/api/auth/agent-identity/verify', {
    challenge: ch.challenge,
    signature: {
      near_account_id: sig.near_account_id,
      public_key: sig.public_key,
      signature: sig.signature,
      nonce: sig.nonce,
      recipient: sig.recipient,
    },
  });
  if (typeof v.token !== 'string' || v.account_id !== sig.near_account_id) {
    throw new Error('NOVA verify returned no session for the signing account');
  }
  return { token: v.token, accountId: v.account_id, expiresIn: v.expires_in };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Writes: a NovaWalletSigner backed by native/near/call
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One in-flight native call. Contains no secret (the args are public on chain anyway). */
export interface PendingNativeCall {
  idempotencyKey: string;
  body: NativeCallBody;
  correlationId?: string;
  savedAt: string;
}

export interface NativeCallBody {
  receiver_id: string;
  method_name: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}

/** Durable storage for the one pending call per agent. Persist it (file, DB row) so a crash
 * between send and answer can be settled with the same key after a restart. */
export interface PendingStore {
  load(): Promise<PendingNativeCall | null>;
  save(pending: PendingNativeCall): Promise<void>;
  clear(): Promise<void>;
}

/** In-process store for tests and scripts. NOT crash-safe: use a durable store in production. */
export function memoryStore(): PendingStore {
  let p: PendingNativeCall | null = null;
  return {
    load: async () => (p ? structuredClone(p) : null),
    save: async (x) => { p = structuredClone(x); },
    clear: async () => { p = null; },
  };
}

export interface AgentSignerOptions {
  store: PendingStore;
  /** Refuse any call attaching more than this (yoctoNEAR). Keep it ≤ the owner's wNEAR cap. */
  maxDepositYocto: bigint;
  contractId?: string;
  /** How long to keep polling a dispatched call before leaving it pending (default 5 min). */
  pollDeadlineMs?: number;
}

/** Thrown when a call may have been sent but its outcome is not settled. It stays in the store. */
export class NativeCallPendingError extends Error {
  constructor(readonly pending: PendingNativeCall, readonly status?: string) {
    super(`NOVA write ${pending.body.method_name} is not settled (${status ?? 'outcome unknown'}); ` +
      `call resolvePending() later, never resend it under a new key`);
    this.name = 'NativeCallPendingError';
  }
}

const MOVING = new Set(['PROCESSING', 'QUEUED', 'UNCERTAIN']);

/** An Agent API error document, also when it comes from ANOTHER copy of the Agent API SDK
 * (a second install, a bundler duplicate): `instanceof` alone would then be false and a proven
 * refusal would be kept as "maybe sent". Matched by the SDK's own error name and typed fields. */
function isAgentApiError(e: unknown): e is Pick<AgentApiError, 'status' | 'code' | 'layer' | 'detail' | 'retryable'> {
  if (e instanceof AgentApiError) return true;
  const x = e as Partial<AgentApiError> | null;
  return !!x && x.name === 'AgentApiError' && typeof x.status === 'number' && typeof x.code === 'string' &&
    typeof x.retryable === 'boolean';
}

async function pollUntilSettled(api: AgentApi, correlationId: string, deadlineMs: number): Promise<StatusResponse> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const st = await api.getStatus(correlationId, { waitMs: 30_000 });
    if (!MOVING.has(st.status) || Date.now() >= end) return st;
  }
}

function txHashOf(st: StatusResponse): string | null {
  return st.type === 'native' ? st.details.tx_hash : null;
}

export interface AgentConnectSigner extends NovaWalletSigner {
  /** Settles a call left pending by a crash, a timeout or an UNCERTAIN outcome. Returns its final
   * status. If it SUCCEEDED, its record is on chain; when that was an upload whose finalize never
   * ran, the record has no bytes (the NOVA dashboard labels it "record without bytes"). */
  resolvePending(): Promise<{ status: string; txHash: string | null } | null>;
}

/**
 * `api` must be a grant client (`api.forGrant(token)`); `accountId` is the agent's
 * `wallet.near_account_id`. Refuses, before anything is sent: another receiver than the NOVA
 * contract, a method nova-sdk-js does not use, a deposit above `maxDepositYocto`, and any new call
 * while one is pending.
 */
export function agentConnectSigner(
  api: AgentApi,
  agentId: string,
  accountId: string,
  opts: AgentSignerOptions,
): AgentConnectSigner {
  const contract = opts.contractId ?? NOVA_CONTRACT_ID;
  const deadline = opts.pollDeadlineMs ?? 5 * 60_000;
  const { store } = opts;

  // Settle a dispatched (or possibly dispatched) call. Returns the final status, or throws
  // NativeCallPendingError while it is still unsettled.
  async function settle(p: PendingNativeCall): Promise<StatusResponse> {
    let correlationId = p.correlationId;
    if (!correlationId) {
      // Sent with no answer: replaying the SAME key and body returns the original result.
      let st;
      try {
        st = await api.nativeNearCall(agentId, p.body, { idempotencyKey: p.idempotencyKey });
      } catch (e) {
        throw await classifyAndStore(e, p);
      }
      correlationId = st.correlation_id;
      await store.save({ ...p, correlationId });
      if (!MOVING.has(st.status)) return st;
    }
    const st = await pollUntilSettled(api, correlationId, deadline);
    if (MOVING.has(st.status)) throw new NativeCallPendingError({ ...p, correlationId }, st.status);
    return st;
  }

  // After a send error: a refusal documented as sending nothing clears the call; anything else
  // (server error, transport, retryable) keeps it pending under the same key.
  async function classifyAndStore(e: unknown, p: PendingNativeCall): Promise<Error> {
    const err = classifySendError(e, p);
    if (!(err instanceof NativeCallPendingError)) await store.clear();
    return err;
  }

  function classifySendError(e: unknown, p: PendingNativeCall): Error {
    if (isAgentApiError(e) && e.status >= 400 && e.status < 500 && !e.retryable) {
      return new Error(`Agent API refused ${p.body.method_name}: ${e.status} ${e.code} [${e.layer ?? '?'}]` +
        (e.detail ? ` ${e.detail}` : ''));
    }
    // Server error, transport failure (AgentApiRequestError), a retryable refusal, or anything
    // unknown: maybe sent.
    return new NativeCallPendingError(p);
  }

  return {
    accountId,

    async signAndSendFunctionCall(call: WalletFunctionCall): Promise<{ txHash: string }> {
      if (call.receiverId !== contract) throw new Error(`refusing: receiver ${call.receiverId} is not ${contract}`);
      if (!(NOVA_WRITE_METHODS as readonly string[]).includes(call.methodName)) {
        throw new Error(`refusing: ${call.methodName} is not a NOVA write method`);
      }
      if (call.deposit < 0n || call.deposit > opts.maxDepositYocto) {
        throw new Error(`refusing: deposit ${call.deposit} yocto exceeds the cap ${opts.maxDepositYocto}`);
      }
      const existing = await store.load();
      if (existing) {
        throw new Error(`a previous NOVA write (${existing.body.method_name}) is pending: call resolvePending() first`);
      }

      const p: PendingNativeCall = {
        idempotencyKey: `nova-${crypto.randomUUID()}`,
        body: {
          receiver_id: call.receiverId,
          method_name: call.methodName,
          args: call.args,
          gas: call.gas.toString(),
          deposit: call.deposit.toString(),
        },
        savedAt: new Date().toISOString(),
      };
      await store.save(p); // BEFORE sending

      let first: StatusResponse;
      try {
        first = await api.nativeNearCall(agentId, p.body, { idempotencyKey: p.idempotencyKey });
      } catch (e) {
        throw await classifyAndStore(e, p);
      }
      const withId = { ...p, correlationId: first.correlation_id };
      await store.save(withId);

      const final = MOVING.has(first.status) ? await settle(withId) : first;
      if (final.status === 'NEEDS_REVIEW') {
        throw new NativeCallPendingError(withId, 'NEEDS_REVIEW: stop and inspect; do not retry');
      }
      await store.clear(); // terminal
      if (final.status !== 'SUCCESS') {
        const reason = final.type === 'native' ? final.details.failure_reason : null;
        throw new Error(`${call.methodName} ended ${final.status}` +
          (final.failure_code ? ` (${final.failure_code})` : '') + (reason ? `: ${reason}` : ''));
      }
      const txHash = txHashOf(final);
      if (!txHash) throw new Error(`${call.methodName} succeeded without a transaction hash`);
      return { txHash };
    },

    async resolvePending() {
      const p = await store.load();
      if (!p) return null;
      const final = await settle(p); // throws NativeCallPendingError while unsettled
      if (final.status === 'NEEDS_REVIEW') throw new NativeCallPendingError(p, 'NEEDS_REVIEW');
      await store.clear();
      return { status: final.status, txHash: txHashOf(final) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// One call: a ready NovaSdk in wallet mode
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ConnectOptions extends AgentSignerOptions {
  novaUrl?: string;
  /** Passed through to nova-sdk-js (rpcUrl, mcpUrl, authUrl). */
  sdkConfig?: Omit<NovaSdkConfig, 'apiKey' | 'sessionToken' | 'walletSigner' | 'contractId'>;
  fetch?: typeof fetch;
}

export interface NovaAgentConnection {
  /** Plain nova-sdk-js in wallet mode: every write is signed and paid by the agent. */
  nova: NovaSdk;
  /** The signer behind `nova`: call `signer.resolvePending()` after a NativeCallPendingError. */
  signer: AgentConnectSigner;
  accountId: string;
  /** Seconds until the NOVA session expires, when NOVA states it. Reconnect after that. */
  sessionExpiresIn?: number;
}

/** Signs the agent in and returns a NovaSdk whose writes the agent signs and pays itself.
 * A pending call (from an earlier crash or timeout) makes every write refuse until
 * `signer.resolvePending()` settles it. */
export async function connectNovaAgent(api: AgentApi, agentId: string, opts: ConnectOptions): Promise<NovaAgentConnection> {
  const agent = await api.getAgent(agentId);
  const accountId = agent.wallet?.near_account_id;
  if (!accountId) throw new Error(`agent ${agentId} has no NEAR account yet`);
  const session = await signInAgent(api, agentId, { novaUrl: opts.novaUrl, fetch: opts.fetch });
  if (session.accountId !== accountId) throw new Error('NOVA session account differs from the agent wallet');
  const signer = agentConnectSigner(api, agentId, accountId, opts);
  const nova = new NovaSdk(accountId, {
    ...(opts.sdkConfig ?? {}),
    contractId: opts.contractId ?? NOVA_CONTRACT_ID,
    sessionToken: session.token,
    walletSigner: signer,
  });
  return { nova, signer, accountId, sessionExpiresIn: session.expiresIn };
}

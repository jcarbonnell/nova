// shade-agent/src/lib/services/agent-identity.ts
//
// Service layer for Agent Connect identity sign-in (phase-2 identity bridge).
// The router is a thin adapter over this, like every other service.
//
// - Lazy singletons: nothing is built at module load, so this stays importable
//   by scripts/generate-openapi.ts (no production .env there) — same rule as
//   lib/config.ts. A bad AGENT_IDENTITY_RECIPIENT throws on FIRST USE, inside a
//   procedure, where mapErrors turns it into a logged 500 — never a boot crash.
// - MAINNET ONLY: the Agent API is mainnet-only, so the lookup always uses
//   NEAR_RPC_URL (never getRpcUrl(network)).
// - The refusal REASON is logged, never sent: the wire carries only the code.

import axios from 'axios';

import { ApiError } from '../errors.js';
import { log } from '../logger.js';
import { NEAR_RPC_URL, AGENT_IDENTITY_RECIPIENT } from '../config.js';
import { AgentChallengeStore, verifyAgentIdentity } from '../agent-identity.js';
import type { AgentSignature, KeyLookup } from '../agent-identity.js';
import { makeKeyLookup } from '../near-key-lookup.js';

let store: AgentChallengeStore | undefined;
let lookup: KeyLookup | undefined;

function getStore(): AgentChallengeStore {
  store ??= new AgentChallengeStore({ audience: AGENT_IDENTITY_RECIPIENT });
  return store;
}

function getLookup(): KeyLookup {
  lookup ??= makeKeyLookup({
    rpcUrl: NEAR_RPC_URL,
    // Any HTTP status yields the parsed body (NEAR RPC errors are in the body);
    // only a transport failure / timeout throws.
    post: async (url, body) =>
      (await axios.post(url, body, { timeout: 10_000, validateStatus: () => true })).data,
  });
  return lookup;
}

export function issueAgentChallenge(): {
  message: string; challenge: string; audience: string; expires_at_ms: number;
} {
  const issued = getStore().issue();
  if (!issued) {
    log('warn', 'agent_identity_capacity', {});
    throw new ApiError(503, 'CHALLENGE_CAPACITY', 'Too many outstanding challenges, retry shortly');
  }
  return {
    message: issued.message,
    challenge: issued.challenge.challenge,
    audience: issued.challenge.audience,
    expires_at_ms: issued.challenge.expires_at_ms,
  };
}

export async function verifyAgentIdentitySignin(input: {
  challenge: string;
  signature: AgentSignature;
}): Promise<{ account_id: string; public_key: string }> {
  const r = await verifyAgentIdentity(
    { store: getStore(), lookup: getLookup() },
    { challenge: input.challenge, signature: input.signature },
  );
  if (r.ok) {
    log('info', 'agent_identity_verified', { auth_method: 'intents_identity', account_id: r.account_id });
    return { account_id: r.account_id, public_key: r.public_key };
  }
  log('warn', 'agent_identity_refused', { code: r.code, reason: r.reason });
  switch (r.code) {
    case 'UNAUTHORIZED_NONCE_REPLAY':
      throw new ApiError(401, r.code, 'Invalid or expired challenge');
    case 'KEY_LOOKUP_UNAVAILABLE':
      throw new ApiError(503, r.code, 'Account lookup unavailable, retry shortly');
    default:
      throw new ApiError(401, 'UNAUTHORIZED', 'Agent identity verification failed');
  }
}
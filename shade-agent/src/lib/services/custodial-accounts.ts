// shade-agent/src/lib/services/custodial-accounts.ts
//
// Operator-created CUSTODIAL testnet accounts (a minimal §5.8, for the Cleanroom
// swarm). Reborn 1.4.1 tools cannot hold a signing key, so these agents stay
// custodial: NOVA signs for them with a key that never leaves the TEE.
//
// Two calls, both behind X-Internal-Auth, both limited to a FIXED allowlist:
//   prepare  → derives the account's keypair inside the TEE and returns ONLY its
//              public half, with the account's state on chain. Writes nothing.
//   (between them the operator creates the account with near-cli, from
//    nova-sdk-7.testnet, with exactly that public key, and funds it)
//   finalize → checks on chain that the account exists and that its ONLY key is
//              that public key (FullAccess); stores the key the same way as for
//              any custodial account (account:{id}, the record MCP signs from);
//              issues the account's first API key and returns it ONCE.
//
// Re-runs are safe. The key is derived (`custodial-account:{account_id}`), so a
// failed or repeated call never draws a different key; a stored record is never
// rewritten; an existing API key is never re-issued unless the operator asks for
// it explicitly (reissue_api_key: true, which rotates: the previous key stops
// verifying). Nothing is left half-done that a re-run cannot complete.
//
// Never returned or logged: the private key. The API key appears only in
// finalize's response body.
//
// ⚠️ Crypto/key path — harness: test/test-custodial-accounts.mjs (+ mutate-custodial-accounts.mjs).

import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { encryptBlob, decryptBlob, deriveKey, sha256Hex, hashForLog } from '../crypto.js';
import { getBlobFromKVStrict, storeBlobToKV, rpcCallWithRetry } from '../kv.js';
import { getRpcUrl } from '../near.js';
import { issueOperatorApiKey } from './user-keys.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';

/** The only accounts these calls will ever touch. Changing it is a reviewed image change. */
export const CUSTODIAL_ALLOWLIST: ReadonlySet<string> = new Set([
  'ironclaw-swarm.nova-sdk-7.testnet',
  'ironclaw-swarm-agent1.nova-sdk-7.testnet',
  'ironclaw-swarm-agent2.nova-sdk-7.testnet',
  'ironclaw-swarm-agent3.nova-sdk-7.testnet',
  'ironclaw-swarm-agent4.nova-sdk-7.testnet',
  'ironclaw-swarm-agent5.nova-sdk-7.testnet',
]);

const NETWORK = 'testnet';
const ED = 'ed25519:';
const accountIdFor = (accountId: string) => sha256Hex(`account:${accountId}`);

const refuse = (status: 403 | 404 | 500 | 503, code: string, msg: string) => new ApiError(status, code, msg);

function allowed(accountId: string): void {
  if (!CUSTODIAL_ALLOWLIST.has(accountId)) {
    throw refuse(403, 'CUSTODIAL_NOT_ALLOWED', `Account not on the custodial allowlist: ${accountId}`);
  }
}

/** The account's keypair, derived inside the TEE. Only `pub` ever leaves this module. */
async function keypairFor(accountId: string): Promise<{ pub: string; secret: string }> {
  const seed = deriveKey(`custodial-account:${accountId}`, 32);
  const pubBytes = await ed25519.getPublicKeyAsync(seed);
  return {
    pub: `${ED}${bs58.encode(pubBytes)}`,
    secret: `${ED}${bs58.encode(Buffer.concat([Buffer.from(seed), Buffer.from(pubBytes)]))}`,
  };
}

type ChainState = { exists: false } | { exists: true; keys: Array<{ public_key: string; full: boolean }> };

/**
 * The account on chain. An absent account is only ever concluded from the RPC's
 * explicit UNKNOWN_ACCOUNT; any other failure is a 503 (fail closed: an outage
 * must never read as "absent").
 */
async function chainState(accountId: string): Promise<ChainState> {
  const rpcUrl = getRpcUrl(NETWORK);
  let res;
  try {
    res = await axios.post(rpcUrl, {
      jsonrpc: '2.0', id: 'custodial-account', method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }, { timeout: 10_000 });
  } catch {
    throw refuse(503, 'CUSTODIAL_CHAIN_UNAVAILABLE', 'Testnet RPC unavailable; retry');
  }
  const err = res.data?.error;
  if (err) {
    if (err.cause?.name === 'UNKNOWN_ACCOUNT') return { exists: false };
    throw refuse(503, 'CUSTODIAL_CHAIN_UNAVAILABLE', 'Testnet RPC unavailable; retry');
  }
  if (!res.data?.result) throw refuse(503, 'CUSTODIAL_CHAIN_UNAVAILABLE', 'Testnet RPC unavailable; retry');

  const r = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'custodial-keys', method: 'query',
    params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId },
  }).catch(() => null) as { keys?: Array<{ public_key: string; access_key: { permission: unknown } }> } | null;
  if (!r?.keys) throw refuse(503, 'CUSTODIAL_CHAIN_UNAVAILABLE', 'Access key list unavailable; retry');
  return { exists: true, keys: r.keys.map((k) => ({ public_key: k.public_key, full: k.access_key.permission === 'FullAccess' })) };
}

/** Exactly one key on the account, FullAccess, equal to `pub`. */
const onlyKeyIs = (state: ChainState, pub: string) =>
  state.exists && state.keys.length === 1 && state.keys[0].public_key === pub && state.keys[0].full;

async function storedRecord(accountId: string): Promise<{ public_key: string } | null> {
  const blob = await getBlobFromKVStrict(accountIdFor(accountId));
  if (!blob) return null;
  return JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
}

export interface CustodialPrepareInput { account_id: string }
export interface CustodialFinalizeInput { account_id: string; reissue_api_key?: boolean }

export async function prepareCustodialAccount(input: CustodialPrepareInput) {
  const { account_id } = input;
  allowed(account_id); // before any KV or chain read

  const { pub } = await keypairFor(account_id);
  const record = await storedRecord(account_id);
  if (record) {
    if (record.public_key !== pub) {
      throw refuse(500, 'CUSTODIAL_RECORD_MISMATCH', 'A stored record holds a different key for this account');
    }
    return { account_id, public_key: pub, state: 'done' as const };
  }

  const state = await chainState(account_id);
  if (!state.exists) return { account_id, public_key: pub, state: 'absent' as const };
  if (onlyKeyIs(state, pub)) return { account_id, public_key: pub, state: 'ready' as const };
  throw refuse(403, 'CUSTODIAL_ACCOUNT_TAKEN', 'The account exists with keys other than the derived key');
}

export async function finalizeCustodialAccount(input: CustodialFinalizeInput) {
  const { account_id, reissue_api_key } = input;
  allowed(account_id); // before any KV or chain read

  const { pub, secret } = await keypairFor(account_id);

  // 1. The chain: the account exists and the derived key is its only key.
  const state = await chainState(account_id);
  if (!state.exists) {
    throw refuse(404, 'CUSTODIAL_ACCOUNT_NOT_READY', 'Create the account with the prepared public key first');
  }
  if (!onlyKeyIs(state, pub)) {
    throw refuse(403, 'CUSTODIAL_ACCOUNT_TAKEN', 'The account exists with keys other than the derived key');
  }

  // 2. The custodial record, written once. MCP signs from account:{id}.
  const record = await storedRecord(account_id);
  let created = false;
  if (record) {
    if (record.public_key !== pub) {
      throw refuse(500, 'CUSTODIAL_RECORD_MISMATCH', 'A stored record holds a different key for this account');
    }
  } else {
    const userData = {
      account_id, private_key: secret, public_key: pub, network: NETWORK, wallet_id: null,
      created_at: new Date().toISOString(), created_by: 'operator-custodial-route',
    };
    await storeBlobToKV(accountIdFor(account_id), encryptBlob(Buffer.from(JSON.stringify(userData), 'utf8')));
    created = true;
  }

  // 3. The API key: issued once; re-issued (rotated) only when asked.
  const issued = await issueOperatorApiKey(account_id, !!reissue_api_key);

  log('warn', 'custodial_account_finalized', {
    account_id_hash: hashForLog(account_id), record_created: created,
    api_key_issued: !!issued, api_key_version: issued?.version ?? null,
  });

  if (!issued) return { account_id, public_key: pub, state: 'done' as const };
  return {
    account_id, public_key: pub,
    state: (reissue_api_key ? 'reissued' : 'created') as 'reissued' | 'created',
    api_key: issued.api_key, api_key_version: issued.version,
  };
}

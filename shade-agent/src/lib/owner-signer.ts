// shade-agent/src/lib/owner-signer.ts
//
// §6.1 Piece 4 — S2: sign AS A CUSTODIAL GROUP OWNER, inside the TEE.
//
// WHY: the access-window sweep must revoke a buyer, and the contract only lets
// the GROUP OWNER call revoke_group_member. Today MCP gets that ability by
// pulling the owner's private key out of Shade over HTTP (/user-keys/retrieve,
// account-only branch). Signing HERE instead means the key never leaves the
// process that already holds it.
//
// S2.1 (this part): loadCustodialSigner — reads account:{id} from KV and returns
// a SIGNER, never a key. The 32-byte seed lives only in a closure; the returned
// object exposes accountId / publicKey / network / sign(). Nothing on it
// serializes to the secret.
//
// Fails CLOSED:
//   • RPC failure          → throws (strict read), never "not found"
//   • no record            → 404 OWNER_KEY_NOT_FOUND
//   • wallet_id set        → 403 OWNER_NOT_CUSTODIAL (wallet users have no
//                             custodial key — Deliverable 2 covers them)
//   • key ≠ stored pubkey  → 500 OWNER_KEY_MISMATCH (never sign with a key that
//                             does not derive the account's recorded public key)
//   • unreadable record    → 500 OWNER_KEY_UNREADABLE
//
// INTERNAL ONLY. No route exposes this. Every load is audit-logged (hashed id),
// mirroring retrieveUserKey's account_only_retrieve.
//
// ⚠️ Crypto/auth path — harness-gate any edit.

import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { decryptBlob, sha256Hex, hashForLog } from './crypto.js';
import crypto from 'crypto';
import {
  getBlobFromKVStrict, rpcCallWithRetry, withSignerLock,
  encodeFunctionCallAction, encodeTransaction, type BroadcastResult,
} from './kv.js';
import { getRpcUrl, resolveContract } from './near.js';
import { log } from './logger.js';
import { ApiError } from './errors.js';

export interface CustodialSigner {
  readonly accountId: string;
  readonly publicKey: Uint8Array;
  readonly publicKeyBs58: string; // 'ed25519:<base58>'
  readonly network: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const ED_PREFIX = 'ed25519:';

function unreadable(): ApiError {
  return new ApiError(500, 'OWNER_KEY_UNREADABLE', 'Custodial key record is unreadable');
}
function mismatch(): ApiError {
  return new ApiError(500, 'OWNER_KEY_MISMATCH', 'Custodial key does not match the recorded public key');
}

/** Decode a NEAR ed25519 secret: 'ed25519:<b58>' or bare b58, 64-byte (seed‖pub) or 32-byte (seed). */
function decodeSecret(sk: string): Uint8Array | null {
  const body = sk.startsWith(ED_PREFIX) ? sk.slice(ED_PREFIX.length) : sk;
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(body);
  } catch {
    return null;
  }
  return bytes.length === 64 || bytes.length === 32 ? bytes : null;
}

function normalizePub(pk: string): string {
  return pk.startsWith(ED_PREFIX) ? pk : `${ED_PREFIX}${pk}`;
}

export async function loadCustodialSigner(accountId: string): Promise<CustodialSigner> {
  const blob = await getBlobFromKVStrict(sha256Hex(`account:${accountId}`)); // throws on RPC error
  if (!blob) throw new ApiError(404, 'OWNER_KEY_NOT_FOUND', 'No custodial key for this account');

  let userData: {
    account_id?: unknown; private_key?: unknown; public_key?: unknown;
    network?: unknown; wallet_id?: unknown;
  };
  try {
    userData = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
  } catch {
    throw unreadable();
  }

  if (userData.wallet_id) {
    throw new ApiError(403, 'OWNER_NOT_CUSTODIAL', 'Account is wallet-owned; NOVA holds no key for it');
  }
  if (userData.account_id !== accountId) throw mismatch();
  if (typeof userData.private_key !== 'string' || typeof userData.public_key !== 'string') throw unreadable();

  const secret = decodeSecret(userData.private_key);
  if (!secret) throw unreadable();

  const seed = secret.slice(0, 32);
  const pub = await ed25519.getPublicKeyAsync(seed);

  // 64-byte form embeds the public half: it must be the one the seed derives.
  if (secret.length === 64 && !Buffer.from(secret.slice(32)).equals(Buffer.from(pub))) throw mismatch();

  const pubBs58 = `${ED_PREFIX}${bs58.encode(pub)}`;
  if (pubBs58 !== normalizePub(userData.public_key)) throw mismatch();

  const network = typeof userData.network === 'string' ? userData.network : 'mainnet';

  log('warn', 'custodial_signer_loaded', { account_id_hash: hashForLog(accountId), network });

  // The seed is captured by the closure below and nowhere else.
  return Object.freeze({
    accountId,
    publicKey: pub,
    publicKeyBs58: pubBs58,
    network,
    sign: (message: Uint8Array) => ed25519.signAsync(message, seed),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// S2.2 — signAsOwner: sign + broadcast ONE allowlisted call as a custodial owner
// ════════════════════════════════════════════════════════════════════════════
//
// Guards, in order (each fails BEFORE the next step runs):
//   1. method allowlist — checked before any key is loaded. Only
//      revoke_group_member today (the access-window sweep). Adding a method is a
//      reviewed code change + harness, never a parameter.
//   2. loadCustodialSigner — wallet refusal + pubkey derivation check (S2.1).
//   3. network — the owner's recorded network must equal the contract's.
//   4. fee — estimate_fee view; an RPC error REFUSES to sign. (MCP's
//      _estimate_fee falls back to 0 and lets the contract panic; not here.)
//   5. per-signer lock (S2.0) around nonce read → sign → broadcast_tx_commit,
//      on the CONTRACT's network RPC — not KV_RPC_URL.
// An on-chain execution Failure THROWS. Callers decide what it means (the sweep
// checks is_authorized first, so "User not a member" never surprises it).
//
// ⚠️ Crypto/auth path — harness-gate any edit.

const OWNER_METHOD_ALLOWLIST: ReadonlySet<string> = new Set(['revoke_group_member']);
const OWNER_CALL_GAS = 100_000_000_000_000n; // 100 TGas — matches MCP's call_contract default

export interface OwnerCallInput {
  owner_account_id: string;
  method_name: string;
  args: Record<string, unknown>;
  contract_id?: string;
}

export interface OwnerCallResult {
  tx_hash: string | undefined;
  signer_account_id: string;
  contract_id: string;
  network: string;
  method_name: string;
  deposit_yocto: string;
  outcome: BroadcastResult;
}

/**
 * estimate_fee(action) → yoctoNEAR as bigint. Parsed from the RAW JSON text, not
 * via JSON.parse, so a u128 above 2^53 can't lose precision. Any RPC error or
 * unparseable value THROWS — we never sign with a guessed deposit.
 */
async function estimateFee(rpcUrl: string, contractId: string, action: string): Promise<bigint> {
  let res: { result?: number[] } | null;
  try {
    res = await rpcCallWithRetry(rpcUrl, {
      jsonrpc: '2.0',
      id: 'owner-fee',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contractId,
        method_name: 'estimate_fee',
        args_base64: Buffer.from(JSON.stringify({ action })).toString('base64'),
      },
    }) as { result?: number[] } | null;
  } catch (err) {
    throw new ApiError(500, 'OWNER_FEE_UNAVAILABLE', `Fee estimate failed: ${(err as Error).message}`);
  }
  const raw = res?.result ? Buffer.from(res.result).toString('utf8').trim() : '';
  const m = /^"?(\d+)"?$/.exec(raw);
  if (!m) throw new ApiError(500, 'OWNER_FEE_UNAVAILABLE', 'Fee estimate returned an unreadable value');
  return BigInt(m[1]);
}

export async function signAsOwner(input: OwnerCallInput): Promise<OwnerCallResult> {
  const { owner_account_id, method_name, args, contract_id } = input;

  // 1. Allowlist — BEFORE any key material is touched.
  if (!OWNER_METHOD_ALLOWLIST.has(method_name)) {
    log('warn', 'owner_call_refused_method', {
      method_name, account_id_hash: hashForLog(owner_account_id),
    });
    throw new ApiError(403, 'OWNER_METHOD_NOT_ALLOWED', `Method not allowed for owner signing: ${method_name}`);
  }

  const { contractId, network } = resolveContract(contract_id);

  // 2. Signer (wallet refusal + pubkey check live in the loader).
  const signer = await loadCustodialSigner(owner_account_id);

  // 3. Network.
  if (signer.network !== network) {
    throw new ApiError(500, 'OWNER_NETWORK_MISMATCH',
      `Owner key is recorded for ${signer.network}; contract ${contractId} is on ${network}`);
  }

  const rpcUrl = getRpcUrl(network);

  // 4. Fee — exact, fail closed.
  const deposit = await estimateFee(rpcUrl, contractId, method_name);
  const argsBytes = Buffer.from(JSON.stringify(args));

  // 5. One critical section per access key (S2.0).
  const outcome = await withSignerLock(`${signer.accountId}|${signer.publicKeyBs58}`, async () => {
    const ak = await rpcCallWithRetry(rpcUrl, {
      jsonrpc: '2.0',
      id: 'owner-access-key',
      method: 'query',
      params: {
        request_type: 'view_access_key',
        finality: 'optimistic', // same reasoning as signAndBroadcastFunctionCall
        account_id: signer.accountId,
        public_key: signer.publicKeyBs58,
      },
    }) as { nonce?: number; block_hash?: string } | null;

    if (!ak || typeof ak.nonce === 'undefined' || !ak.block_hash) {
      throw new ApiError(500, 'OWNER_ACCESS_KEY_NOT_FOUND', 'Owner access key not found on chain');
    }

    const nonce = BigInt(ak.nonce) + 1n;
    const action = encodeFunctionCallAction(method_name, argsBytes, OWNER_CALL_GAS, deposit);
    const txBytes = encodeTransaction(
      signer.accountId, signer.publicKey, nonce, contractId, bs58.decode(ak.block_hash), [action],
    );
    const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
    const signature = await signer.sign(txHash);
    const signedTx = Buffer.concat([txBytes, Buffer.from([0]), Buffer.from(signature)]);

    const result = await rpcCallWithRetry(rpcUrl, {
      jsonrpc: '2.0',
      id: 'owner-broadcast',
      method: 'broadcast_tx_commit',
      params: [signedTx.toString('base64')],
    }) as BroadcastResult;

    if (result?.status?.Failure) {
      throw new ApiError(500, 'OWNER_CALL_FAILED',
        `Contract execution failed: ${JSON.stringify(result.status.Failure)}`);
    }
    return result;
  });

  const tx_hash = outcome?.transaction?.hash;
  log('info', 'owner_call_signed', {
    method_name, account_id_hash: hashForLog(owner_account_id),
    contract_id: contractId, network, tx_hash,
  });

  return {
    tx_hash,
    signer_account_id: signer.accountId,
    contract_id: contractId,
    network,
    method_name,
    deposit_yocto: deposit.toString(),
    outcome,
  };
}
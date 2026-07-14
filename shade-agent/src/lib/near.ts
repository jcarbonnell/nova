// shade-agent/src/lib/near.ts
//
// NEAR contract interaction: view calls, contract resolution, and the generic
// contract-call broadcaster. Lifted verbatim from routes/key-management.ts.
//
// Distinct from lib/kv.ts, which talks to the KV contract (nova-kv.near) and
// owns the transaction-serialization primitives this module reuses.
//
// ⚠️  THREE SIGNER IDENTITIES EXIST. Do not "unify" them without understanding why:
//   1. lib/kv.ts storeBlobToKV   → signs as nova-sdk.near,        salt 'kv-owner-signer-v1'
//   2. broadcastContractCall     → signs as kv-signer.nova-kv.near, salt 'nova-signer-v1'
//   3. (deleted in v0.4 step 2)  → the dead src/utils/ signer,      salt 'enclave-signer'
// (2) is LIVE — it is what the revoke path uses to call revoke_group_member on
// the NOVA contract. Its derived public key is registered as an access key on
// kv-signer.nova-kv.near. Changing the salt or the signer account breaks revocation.
// Roadmap flags this for investigation before the Step 9 config work touches signing.
// This module MOVES the function; it does not change it.

import crypto from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { deriveKey } from './crypto.js';
import {
  rpcCallWithRetry,
  encodeFunctionCallAction,
  encodeTransaction,
  KV_CONTRACT,
} from './kv.js';
import { log } from './logger.js';

// ────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────

export const DEFAULT_MAINNET_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk.near';
export const DEFAULT_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT_ID || 'nova-sdk-6.testnet';

const ALLOWED_CONTRACTS = new Set([DEFAULT_MAINNET_CONTRACT, DEFAULT_TESTNET_CONTRACT]);

// KNOWN ISSUE (preserved verbatim; → Step 9 config work, "no hardcoded RPC URLs"):
// these URLs are hardcoded rather than sourced from config.
export function getRpcUrl(network: string): string {
  return network === 'testnet' ? 'https://rpc.testnet.near.org' : 'https://rpc.mainnet.near.org';
}

/**
 * Resolve which NOVA contract a request targets.
 * An unrecognised contract_id silently falls back to mainnet — an allowlist, not
 * a validator. Preserved as-is; tightening it is a behaviour change.
 */
export function resolveContract(
  requestContractId?: string,
  _groupId?: string,
): { contractId: string; network: string } {
  if (requestContractId && ALLOWED_CONTRACTS.has(requestContractId)) {
    const network = requestContractId.endsWith('.testnet') ? 'testnet' : 'mainnet';
    return { contractId: requestContractId, network };
  }
  return { contractId: DEFAULT_MAINNET_CONTRACT, network: 'mainnet' };
}

// ────────────────────────────────────────────────
// View calls
// ────────────────────────────────────────────────

export async function viewFunction(
  rpcUrl: string,
  contractId: string,
  methodName: string,
  args: unknown,
): Promise<unknown> {
  const response = await axios.post(rpcUrl, {
    jsonrpc: '2.0',
    id: 'nova-view',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  });

  if (response.data.error) {
    console.error('RPC error:', response.data.error);
    return null;
  }

  const result = response.data.result?.result;
  if (!result) return null;

  const decoded = Buffer.from(result).toString('utf-8');
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded === 'true';
  }
}

// ────────────────────────────────────────────────
// Contract call broadcaster
// ────────────────────────────────────────────────

/** Signs as kv-signer.{KV_CONTRACT} with salt 'nova-signer-v1'. See the warning above. */
export async function broadcastContractCall(
  contractId: string,
  network: string,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: string = '0',
): Promise<void> {
  const rpcUrl = network === 'testnet'
    ? 'https://rpc.testnet.near.org'
    : (process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org');
  const signerAccountId = `kv-signer.${KV_CONTRACT}`;

  const signerPriv = deriveKey('nova-signer-v1', 32);
  const signerPub = await ed25519.getPublicKeyAsync(signerPriv);
  const signerPubBs58 = `ed25519:${bs58.encode(signerPub)}`;

  log('info', 'broadcast_contract_call_attempt', {
    signerAccountId,
    signerPubBs58,
    contractId,
    methodName,
    depositYocto,
    rpcUrl,
  });

  const accessKeyResult = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'access-key',
    method: 'query',
    params: {
      request_type: 'view_access_key',
      finality: 'final',
      account_id: signerAccountId,
      public_key: signerPubBs58,
    },
  }) as { nonce: number; block_hash: string };

  const nonce = BigInt(accessKeyResult.nonce) + 1n;
  const blockHash = bs58.decode(accessKeyResult.block_hash);
  const callArgs = Buffer.from(JSON.stringify(args));
  const deposit = BigInt(depositYocto);
  const action = encodeFunctionCallAction(methodName, callArgs, 50_000_000_000_000n, deposit);
  const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, contractId, blockHash, [action]);
  const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
  const signature = await ed25519.signAsync(txHash, signerPriv);
  const signedTx = Buffer.concat([txBytes, Buffer.from([0]), signature]);

  const broadcastResult = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'broadcast',
    method: 'broadcast_tx_commit',
    params: [signedTx.toString('base64')],
  }) as { transaction?: { hash: string }; status?: { Failure?: unknown } };

  if (broadcastResult?.status?.Failure) {
    throw new Error(`Contract call failed: ${JSON.stringify(broadcastResult.status.Failure)}`);
  }
  log('info', 'contract_call_committed', {
    contractId, methodName, txHash: broadcastResult?.transaction?.hash,
  });
}
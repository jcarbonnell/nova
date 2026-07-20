// shade-agent/src/lib/near.ts
//
// NEAR contract interaction: view calls, contract resolution, and the generic
// contract-call broadcaster. Lifted verbatim from routes/key-management.ts.
//
// Distinct from lib/kv.ts, which talks to the KV contract (nova-kv.near) and
// owns the transaction-serialization primitives this module reuses.
//
// ⚠️  ONE SIGNER IDENTITY REMAINS. History matters here:
//   1. lib/kv.ts storeBlobToKV  → signs as nova-sdk.near, salt 'kv-owner-signer-v1'.
//      LIVE. The derived public key is registered as an access key on
//      nova-sdk.near. Changing the salt breaks every KV write.
//   2. (RETIRED, Shade v38)     → kv-signer.nova-kv.near, salt 'nova-signer-v1'.
//      Used by broadcastContractCall for the revoke path. Its key was NEVER
//      provisioned (empty access-key list), so the path threw BigInt(undefined)
//      on the nonce. Fixed by having MCP sign the on-chain revoke AS THE USER
//      (the contract requires caller == group.owner anyway); the service, the
//      broadcaster and the route were deleted.
//   3. (DELETED, v0.4 step 2)   → the dead src/utils/ signer, salt 'enclave-signer'.
// Step 9's config work must not resurrect (2) or (3).

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
// 7.1 (RPC provider swap): now env-driven with FastNear defaults. The full
// config.ts centralization remains Step 9; this is the minimal env-read that
// lets .env redirect the endpoint and stops the deprecated-host -429s on the
// view/revoke path. Fallback (not throw) is deliberate: .env is always present.
export function getRpcUrl(network: string): string {
  return network === 'testnet'
    ? process.env.NEAR_TESTNET_RPC_URL || 'https://rpc.testnet.fastnear.com'
    : process.env.NEAR_RPC_URL || 'https://rpc.mainnet.fastnear.com';
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
    // JSON.stringify FIRST to avoid circular-structure errors in the log. The error is still thrown.
    log('warn', 'view_call_rpc_error', {
      contract_id: contractId,
      method: methodName,
      rpc_error: JSON.stringify(response.data.error),
    });
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
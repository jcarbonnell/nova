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
import axios from 'axios';
import { NOVA_MAINNET_CONTRACT, NOVA_TESTNET_CONTRACT } from './config.js';
import { log } from './logger.js';
export { getRpcUrl } from './config.js';
// ────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────
// Aliased from lib/config.ts.
export const DEFAULT_MAINNET_CONTRACT = NOVA_MAINNET_CONTRACT;
export const DEFAULT_TESTNET_CONTRACT = NOVA_TESTNET_CONTRACT;
const ALLOWED_CONTRACTS = new Set([DEFAULT_MAINNET_CONTRACT, DEFAULT_TESTNET_CONTRACT]);
/**
 * Resolve which NOVA contract a request targets.
 * An unrecognised contract_id silently falls back to mainnet — an allowlist, not
 * a validator. Preserved as-is; tightening it is a behaviour change.
 */
export function resolveContract(requestContractId, _groupId) {
    if (requestContractId && ALLOWED_CONTRACTS.has(requestContractId)) {
        const network = requestContractId.endsWith('.testnet') ? 'testnet' : 'mainnet';
        return { contractId: requestContractId, network };
    }
    return { contractId: DEFAULT_MAINNET_CONTRACT, network: 'mainnet' };
}
// ────────────────────────────────────────────────
// View calls
// ────────────────────────────────────────────────
export async function viewFunction(rpcUrl, contractId, methodName, args) {
    const t0 = Date.now();
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
            duration_ms: Date.now() - t0,
            rpc_error: JSON.stringify(response.data.error),
        });
        return null;
    }
    const result = response.data.result?.result;
    if (!result) {
        log('info', 'view_call', { contract_id: contractId, method: methodName, empty: true, duration_ms: Date.now() - t0 });
        return null;
    }
    log('info', 'view_call', { contract_id: contractId, method: methodName, empty: false, duration_ms: Date.now() - t0 });
    const decoded = Buffer.from(result).toString('utf-8');
    try {
        return JSON.parse(decoded);
    }
    catch {
        return decoded === 'true';
    }
}

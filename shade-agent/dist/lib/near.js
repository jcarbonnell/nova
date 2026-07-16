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
import axios from 'axios';
// ────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────
export const DEFAULT_MAINNET_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk.near';
export const DEFAULT_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT_ID || 'nova-sdk-6.testnet';
const ALLOWED_CONTRACTS = new Set([DEFAULT_MAINNET_CONTRACT, DEFAULT_TESTNET_CONTRACT]);
// KNOWN ISSUE (preserved verbatim; → Step 9 config work, "no hardcoded RPC URLs"):
// these URLs are hardcoded rather than sourced from config.
export function getRpcUrl(network) {
    return network === 'testnet' ? 'https://rpc.testnet.near.org' : 'https://rpc.mainnet.near.org';
}
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
    if (!result)
        return null;
    const decoded = Buffer.from(result).toString('utf-8');
    try {
        return JSON.parse(decoded);
    }
    catch {
        return decoded === 'true';
    }
}

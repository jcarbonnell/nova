// shade-agent/src/lib/kv.ts
//
// KV contract access + manual NEAR transaction construction.
// Lifted from the duplicated copies in routes/user-keys.ts and
// routes/key-management.ts.
//
// One deliberate reconciliation: storeBlobToKV had DRIFTED between the two
// routes — key-management.ts carried an extra access-key existence check with a
// helpful `near add-key` error message, user-keys.ts did not. The transaction
// built on the success path was byte-identical in both, so no blob
// incompatibility ever occurred. The key-management version is a strict
// superset, so that is the one kept here. This is the only difference from a
// pure verbatim lift, and it only affects the error path.
//
// BY DESIGN: KV access is SINGLE-NETWORK.
// nova-kv.near is the only KV contract — there is no testnet counterpart. The
// blobs it holds (master seed, user keys, group-key metadata, API-key hashes)
// are per-DEPLOYMENT, not per-network; the dual-network split applies to the
// NOVA contract (see lib/near.ts resolveContract), not to KV. Routing KV reads
// through NEAR_TESTNET_RPC_URL would query a contract that does not exist.
import crypto from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';
import { log } from './logger.js';
import { deriveKey } from './crypto.js';
import { KV_RPC_URL, KV_CONTRACT, KV_CONTRACT_OWNER } from './config.js';
// ────────────────────────────────────────────────
// Configuration — single-sourced from lib/config.ts
// ────────────────────────────────────────────────
export { KV_CONTRACT, KV_CONTRACT_OWNER };
// ────────────────────────────────────────────────
// RPC
// ────────────────────────────────────────────────
export async function rpcCallWithRetry(rpcUrl, payload, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await axios.post(rpcUrl, payload, { timeout: 10_000 });
            if (res.data.error) {
                const msg = res.data.error.message || res.data.error.cause?.name || JSON.stringify(res.data.error);
                throw new Error(`RPC error: ${msg}`);
            }
            return res.data.result;
        }
        catch (err) {
            const isLast = attempt === retries - 1;
            if (isLast)
                throw err;
            const backoffMs = 1_000 * (attempt + 1);
            log('warn', 'rpc_retry', { attempt: attempt + 1, backoffMs, error: err.message });
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }
    throw new Error('rpcCallWithRetry: exhausted retries without throwing');
}
export async function getBlobFromKV(key) {
    // KV is single-network by design (see lib/config.ts): nova-kv.near has no
    // testnet counterpart, so KV_RPC_URL is always the mainnet endpoint.
    const rpcUrl = KV_RPC_URL;
    const payload = {
        jsonrpc: '2.0',
        id: 'kv-get',
        method: 'query',
        params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: KV_CONTRACT,
            method_name: 'get',
            args_base64: Buffer.from(JSON.stringify({ key })).toString('base64'),
        },
    };
    // metrics-via-logs: duration_ms replaces the deferred kv_read_duration_ms histogram. Percentiles on demand.
    const t0 = Date.now();
    try {
        const result = await rpcCallWithRetry(rpcUrl, payload);
        if (result?.result && result.result.length > 0) {
            const jsonStr = Buffer.from(result.result).toString('utf8');
            const parsed = JSON.parse(jsonStr);
            if (!parsed || parsed.length === 0) {
                log('info', 'kv_get', { key_id_hash: key.slice(0, 12), found: false, duration_ms: Date.now() - t0 });
                return null;
            }
            log('info', 'kv_get', { key_id_hash: key.slice(0, 12), found: true, duration_ms: Date.now() - t0 });
            return parsed;
        }
        log('info', 'kv_get', { key_id_hash: key.slice(0, 12), found: false, duration_ms: Date.now() - t0 });
        return null;
    }
    catch (err) {
        // Scrubbed by the logger: axios error text echoes the request URL, which
        // carries ?apiKey= once the FastNear key is configured (7.1).
        log('warn', 'kv_get_failed', {
            key_id_hash: key.slice(0, 12),
            duration_ms: Date.now() - t0,
            message: err.message,
        });
        return null;
    }
}
// ────────────────────────────────────────────────
// Borsh primitives for manual NEAR transaction serialization
// ────────────────────────────────────────────────
export function borshString(s) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
}
export function borshBytes(b) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
}
export function borshU64(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(n, 0);
    return buf;
}
export function borshU128(n) {
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
    buf.writeBigUInt64LE(n >> 64n, 8);
    return buf;
}
/** NEAR action enum index 2 = FunctionCall */
export function encodeFunctionCallAction(methodName, args, gas, deposit) {
    return Buffer.concat([
        Buffer.from([2]),
        borshString(methodName),
        borshBytes(args),
        borshU64(gas),
        borshU128(deposit),
    ]);
}
/** Borsh-encoded NEAR Transaction (pre-signature) */
export function encodeTransaction(signerId, publicKey, nonce, receiverId, blockHash, actions) {
    const actionsCount = Buffer.alloc(4);
    actionsCount.writeUInt32LE(actions.length, 0);
    return Buffer.concat([
        borshString(signerId),
        Buffer.from([0]),
        publicKey,
        borshU64(nonce),
        borshString(receiverId),
        blockHash,
        actionsCount,
        ...actions,
    ]);
}
// ────────────────────────────────────────────────
// KV write (signed NEAR transaction)
// ────────────────────────────────────────────────
export async function storeBlobToKV(key, encryptedBlob) {
    // Covers the WHOLE write: key derivation, access-key/nonce fetch, signing and broadcast_tx_commit.
    const t0 = Date.now();
    const rpcUrl = KV_RPC_URL;
    const signerAccountId = KV_CONTRACT_OWNER;
    // 1. Derive deterministic signer keypair from master seed.
    //    Salt 'kv-owner-signer-v1' is LIVE — the derived public key is registered
    //    as an access key on nova-sdk.near. Changing it breaks all KV writes.
    const signerPriv = deriveKey('kv-owner-signer-v1', 32);
    const signerPub = await ed25519.getPublicKeyAsync(signerPriv);
    const signerPubBs58 = `ed25519:${bs58.encode(signerPub)}`;
    // 2. Fetch current nonce + recent block hash for the signer access key
    const accessKeyResult = await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'access-key',
        method: 'query',
        params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: signerAccountId,
            public_key: signerPubBs58,
        },
    });
    if (!accessKeyResult || typeof accessKeyResult.nonce === 'undefined') {
        throw new Error(`Access key not found for ${signerAccountId} with public key ${signerPubBs58}\n` +
            `Please add the key with:\n` +
            `near add-key ${signerAccountId} ${signerPubBs58} --accountId nova-kv.near --networkId mainnet`);
    }
    const nonce = BigInt(accessKeyResult.nonce) + 1n;
    const blockHash = bs58.decode(accessKeyResult.block_hash);
    // 3. Encode FunctionCall action + full transaction.
    //    encryptBlob returns the COMPLETE stored layout as a single hex string.
    const rawBytes = Buffer.from(encryptedBlob, 'hex');
    const callArgs = Buffer.from(JSON.stringify({ key, encrypted_blob: Array.from(rawBytes) }));
    const action = encodeFunctionCallAction('store', callArgs, 30000000000000n, 0n);
    const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, KV_CONTRACT, blockHash, [action]);
    // 4. Hash and sign (NEAR signs SHA-256 of the borsh-encoded transaction)
    const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
    const signature = await ed25519.signAsync(txHash, signerPriv);
    // 5. Borsh-encode SignedTransaction = Transaction + Signature
    const signedTx = Buffer.concat([
        txBytes,
        Buffer.from([0]), // Signature enum: 0 = ed25519
        signature, // 64 bytes
    ]);
    // 6. Broadcast
    const broadcastResult = await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'broadcast',
        method: 'broadcast_tx_commit',
        params: [signedTx.toString('base64')],
    });
    if (broadcastResult?.status?.Failure) {
        throw new Error(`Contract execution failed: ${JSON.stringify(broadcastResult.status.Failure)}`);
    }
    log('info', 'kv_store_committed', {
        key_id_hash: key.slice(0, 12),
        txHash: broadcastResult?.transaction?.hash,
        duration_ms: Date.now() - t0,
    });
}

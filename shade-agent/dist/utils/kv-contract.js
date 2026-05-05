import axios from 'axios';
import * as ed25519 from '@noble/ed25519';
import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { transactions, utils } from 'near-api-js';
import { getEnclaveSigner } from './derivation';
const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
const MAINNET_RPC = 'https://rpc.mainnet.near.org';
/**
 * Read encrypted blob from KV contract
 */
export async function getBlobFromKV(key) {
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
    try {
        const res = await axios.post(MAINNET_RPC, payload, { timeout: 10000 });
        if (res.data.error) {
            console.error(`KV get error for key "${key}":`, res.data.error);
            return null;
        }
        const result = res.data.result?.result;
        if (!result || result.length === 0) {
            return null;
        }
        const decoded = Buffer.from(result).toString('utf-8');
        if (decoded === 'null' || decoded === '') {
            return null;
        }
        return decoded;
    }
    catch (err) {
        console.error(`KV get failed for key "${key}":`, err);
        return null;
    }
}
/**
 * Write encrypted blob to KV contract
 */
export async function storeBlobToKV(key, encryptedBlob) {
    const enclaveSigner = getEnclaveSigner();
    const signerAccountId = `kv-signer.${KV_CONTRACT}`;
    console.log(`📝 Storing blob to KV (key: ${key})...`);
    // Step 1: Get access key info (nonce and block hash)
    const accessKeyRes = await axios.post(MAINNET_RPC, {
        jsonrpc: '2.0',
        id: 'get-access-key',
        method: 'query',
        params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: signerAccountId,
            public_key: `ed25519:${bs58.encode(enclaveSigner.publicKey)}`,
        },
    });
    if (accessKeyRes.data.error) {
        const errorMsg = accessKeyRes.data.error.cause?.name || 'Unknown';
        throw new Error(`Enclave signer not configured: ${errorMsg}\n` +
            `Add key with: near add-key kv-signer.${KV_CONTRACT} ed25519:${bs58.encode(enclaveSigner.publicKey)}`);
    }
    const nonce = accessKeyRes.data.result.nonce + 1;
    const blockHashB64 = accessKeyRes.data.result.block_hash;
    const blockHash = utils.serialize.base_decode(blockHashB64);
    // Step 2: Prepare function call arguments
    const blobBytes = Array.from(Buffer.from(encryptedBlob, 'utf-8'));
    const args = { key, encrypted_blob: blobBytes };
    // Step 3: Create function call action
    const action = transactions.functionCall('store', Buffer.from(JSON.stringify(args)), BigInt(30_000_000_000_000), // 30 TGas
    BigInt(1_000_000_000_000_000_000_000_000) // 1 NEAR deposit
    );
    // Step 4: Create transaction
    const publicKey = utils.PublicKey.fromString(`ed25519:${bs58.encode(enclaveSigner.publicKey)}`);
    const transaction = transactions.createTransaction(signerAccountId, publicKey, KV_CONTRACT, nonce, [action], blockHash);
    // Step 5: Sign transaction
    const serializedTx = utils.serialize.serialize(transactions.SCHEMA.Transaction, transaction);
    const txHash = new Uint8Array(sha256(serializedTx));
    const signatureData = await ed25519.signAsync(txHash, enclaveSigner.privateKey);
    const signedTx = new transactions.SignedTransaction({
        transaction,
        signature: new transactions.Signature({
            keyType: transaction.publicKey.keyType,
            data: signatureData,
        }),
    });
    // Step 6: Broadcast transaction
    const signedTxSerialized = signedTx.encode();
    const broadcastRes = await axios.post(MAINNET_RPC, {
        jsonrpc: '2.0',
        id: 'broadcast-tx',
        method: 'broadcast_tx_commit',
        params: [Buffer.from(signedTxSerialized).toString('base64')],
    });
    if (broadcastRes.data.error) {
        throw new Error(`KV store failed: ${JSON.stringify(broadcastRes.data.error)}`);
    }
    console.log(`✅ Blob stored (key: ${key})`);
}

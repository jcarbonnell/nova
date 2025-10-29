"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NovaSdk = exports.NovaError = void 0;
const accounts_1 = require("@near-js/accounts");
const providers_1 = require("@near-js/providers");
const signers_1 = require("@near-js/signers");
const crypto_1 = require("@near-js/crypto");
const axios_1 = __importDefault(require("axios"));
const crypto = __importStar(require("crypto"));
const buffer_1 = require("buffer");
const bs58_1 = __importDefault(require("bs58"));
class NovaError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'NovaError';
    }
}
exports.NovaError = NovaError;
class NovaSdk {
    provider;
    account;
    privateKey;
    contractId;
    shadeApiUrl;
    pinataKey;
    pinataSecret;
    constructor(rpcUrl, contractId, pinataKey, pinataSecret, shadeApiUrl) {
        this.provider = new providers_1.JsonRpcProvider({ url: rpcUrl });
        this.contractId = contractId;
        this.shadeApiUrl = shadeApiUrl;
        this.pinataKey = pinataKey;
        this.pinataSecret = pinataSecret;
    }
    async withSigner(privateKey, accountId) {
        try {
            const keyPair = crypto_1.KeyPair.fromString(privateKey);
            const signer = new signers_1.KeyPairSigner(keyPair);
            this.account = new accounts_1.Account(accountId, this.provider, signer);
            this.privateKey = privateKey;
            return this;
        }
        catch (e) {
            throw new NovaError('Signing error', e);
        }
    }
    async getBalance(accountId) {
        try {
            const accountView = await this.provider.viewAccount(accountId);
            return accountView.amount.toString();
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async isAuthorized(groupId, userId) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'is_authorized',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    // Deprecated: Use getShadeKey for v2 (off-chain TEE keys)
    async getGroupKey(groupId, userId) {
        console.warn('getGroupKey is deprecated in v0.2.0; use getShadeKey for secure TEE access');
        return this.getShadeKey(groupId, userId);
    }
    // Fetch key via token + Shade (ed25519-signed payload)
    async getShadeKey(groupId, userId) {
        if (!this.shadeApiUrl)
            throw new NovaError('shadeApiUrl required for v2 keys');
        if (!this.account || !this.privateKey)
            throw new NovaError('Signer required (withSigner)');
        try {
            const timestamp = BigInt(Date.now() * 1_000_000); // ns approx
            const nonceInput = `${groupId}${userId}${timestamp}`;
            const nonce = crypto.createHash('sha256').update(nonceInput).digest('hex');
            // Gen payload
            let payload = { group_id: groupId, user_id: userId, nonce, timestamp: Number(timestamp) };
            // Reparse privateKey to KeyPair (avoids private signer)
            const keyPair = crypto_1.KeyPair.fromString(this.privateKey);
            const publicKeyObj = keyPair.getPublicKey(); // Call getPublicKey() method
            const publicBytes = new Uint8Array(publicKeyObj.data); // Raw 32 bytes (Uint8Array)
            const signingPkB58 = bs58_1.default.encode(publicBytes); // Base58 without prefix
            payload.signing_pk_b58 = signingPkB58;
            const payloadStr = JSON.stringify(payload);
            const payloadBytes = buffer_1.Buffer.from(payloadStr, 'utf-8');
            const payloadB64 = payloadBytes.toString('base64');
            // Sign raw payloadBytes (ed25519) - Buffer.from(sigBytes.data) for Signature.data (Uint8Array)
            const sigBytes = keyPair.sign(new Uint8Array(payloadBytes));
            const sigHex = buffer_1.Buffer.from(sigBytes.signature).toString('hex');
            // Claim token on-chain (payable as user)
            const claimArgs = { group_id: groupId, payload_b64: payloadB64, signature_hex: sigHex };
            const claimResult = await this.account.functionCall({
                contractId: this.contractId,
                methodName: 'claim_token',
                args: claimArgs,
                gas: 300000000000000n,
                attachedDeposit: 1000000000000000000n, // 0.001 NEAR
                walletCallbackUrl: undefined,
            });
            // Parse token from receipt/logs (adapt based on actual; assume in status or logs[0])
            const token = claimResult?.receipts_outcome?.[0]?.outcome?.logs?.[0] || ''; // Simplified; enhance if needed
            if (!token || !token.includes('.'))
                throw new NovaError('Token claim failed');
            // Fetch from Shade
            const shadeRes = await axios_1.default.post(`${this.shadeApiUrl}/api/key-management/get_key`, { group_id: groupId, token });
            if (shadeRes.status !== 200)
                throw new NovaError(`Shade fetch failed: ${shadeRes.data}`);
            const { key, checksum } = shadeRes.data;
            if (!key || !checksum)
                throw new NovaError('Invalid Shade response');
            // Verify checksum on-chain
            const checksumRes = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_group_checksum',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId })).toString('base64'),
                finality: 'final',
            });
            const expectedChecksum = buffer_1.Buffer.from(checksumRes.result).toString().trim();
            if (expectedChecksum !== checksum)
                throw new NovaError('Shade attestation invalid');
            return key;
        }
        catch (e) {
            throw new NovaError(`Shade key fetch failed: ${e}`, e);
        }
    }
    async getTransactionsForGroup(groupId, userId) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_transactions_for_group',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    // Owner updates Shade checksum post-gen
    async updateChecksum(groupId, checksum) {
        if (!this.account)
            throw new NovaError('Signer required');
        try {
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName: 'update_checksum',
                args: { group_id: groupId, checksum },
                gas: 300000000000000n,
                attachedDeposit: 10000000000000000000n, // 0.00001 NEAR
                walletCallbackUrl: undefined,
            });
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Checksum update failed: ${e}`, e);
        }
    }
    // Owner approves Shade code hash
    async approveShadeCodeHash(codeHash) {
        if (!this.account)
            throw new NovaError('Signer required');
        try {
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName: 'approve_shade_code_hash',
                args: { code_hash: codeHash },
                gas: 300000000000000n,
                attachedDeposit: 100000000000000000n, // 0.0000001 NEAR
                walletCallbackUrl: undefined,
            });
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Code hash approval failed: ${e}`, e);
        }
    }
    // Register Shade worker (attestation bytes)
    async registerShadeWorker(userId, attestation) {
        if (!this.account)
            throw new NovaError('Signer required');
        try {
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName: 'register_shade_worker',
                args: { user_id: userId, attestation: attestation.toString('base64') },
                gas: 300000000000000n,
                attachedDeposit: 100000000000000000n,
                walletCallbackUrl: undefined,
            });
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Worker registration failed: ${e}`, e);
        }
    }
    // View nonce validity (for shade)
    async getNonceValidity(groupId, userId, nonce) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_nonce_validity',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId, nonce })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Nonce check failed: ${e}`, e);
        }
    }
    // Stub for shade signatures (restricted paths)
    async requestSignature(path, payload, keyType) {
        if (!this.account)
            throw new NovaError('Signer required');
        try {
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName: 'request_signature',
                args: { path, payload: payload.toString('base64'), key_type: keyType || 'ed25519' },
                gas: 300000000000000n,
                attachedDeposit: 100000000000000000n,
                walletCallbackUrl: undefined, // FIX v4
            });
            return 'Success'; // Returns sig hex in prod
        }
        catch (e) {
            throw new NovaError(`Signature request failed: ${e}`, e);
        }
    }
    async executeContractCall(methodName, args, depositYocto) {
        if (!this.account)
            throw new NovaError('No signer attached');
        try {
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName,
                args,
                gas: 300000000000000n,
                attachedDeposit: BigInt(depositYocto),
                walletCallbackUrl: undefined,
            });
            return result ? 'Success' : 'No result';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async registerGroup(groupId) {
        const result = await this.executeContractCall('register_group', { group_id: groupId }, '100000000000000000000000');
        // Shade gen triggered off-chain; checksum update manual if needed
        return result;
    }
    async addGroupMember(groupId, userId) {
        return this.executeContractCall('add_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    async revokeGroupMember(groupId, userId) {
        return this.executeContractCall('revoke_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    // Deprecated: Keys now auto-generated in shade on register
    async storeGroupKey(groupId, keyB64) {
        console.warn('storeGroupKey deprecated in v0.2.0; keys managed in shade TEEs');
        return 'Deprecated';
    }
    async recordTransaction(groupId, userId, fileHash, ipfsHash) {
        const result = await this.executeContractCall('record_transaction', {
            group_id: groupId,
            user_id: userId,
            file_hash: fileHash,
            ipfs_hash: ipfsHash,
        }, '2000000000000000000000');
        // Parse trans_id from logs if needed (v2 returns directly)
        return result;
    }
    async transferTokens(toAccount, amountYocto) {
        if (!this.account)
            throw new NovaError('No signer attached');
        try {
            await this.account.sendMoney(toAccount, BigInt(amountYocto));
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    // Uses getShadeKey
    async compositeUpload(groupId, userId, data, filename) {
        const keyB64 = await this.getShadeKey(groupId, userId);
        const encryptedB64 = this.encryptData(data, keyB64);
        const cid = await this.ipfsUpload(encryptedB64, filename);
        const fileHash = this.computeHash(data).toString('hex');
        const transId = await this.recordTransaction(groupId, userId, fileHash, cid);
        return { cid, trans_id: transId, file_hash: fileHash };
    }
    // Uses getShadeKey
    async compositeRetrieve(groupId, ipfsHash) {
        if (!ipfsHash.startsWith('Qm'))
            throw new NovaError(`Invalid CID: ${ipfsHash}`);
        const userId = this.account.accountId;
        const keyB64 = await this.getShadeKey(groupId, userId);
        const encryptedB64 = await this.ipfsRetrieve(ipfsHash);
        const decryptedB64 = this.decryptData(encryptedB64, keyB64);
        const data = buffer_1.Buffer.from(decryptedB64, 'base64');
        const fileHash = this.computeHash(data).toString('hex');
        return { data, file_hash: fileHash };
    }
    encryptData(data, keyB64) {
        const key = buffer_1.Buffer.from(keyB64, 'base64');
        if (key.length !== 32)
            throw new NovaError('Invalid key length');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(data);
        encrypted = buffer_1.Buffer.concat([encrypted, cipher.final()]);
        const result = buffer_1.Buffer.concat([iv, encrypted]);
        return result.toString('base64');
    }
    decryptData(encryptedB64, keyB64) {
        const key = buffer_1.Buffer.from(keyB64, 'base64');
        if (key.length !== 32)
            throw new NovaError('Invalid key length');
        const encrypted = buffer_1.Buffer.from(encryptedB64, 'base64');
        if (encrypted.length < 16)
            throw new NovaError('Invalid encrypted data');
        const iv = encrypted.slice(0, 16);
        const ciphertext = encrypted.slice(16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = buffer_1.Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString('base64');
    }
    async ipfsUpload(dataB64, filename) {
        const data = buffer_1.Buffer.from(dataB64, 'base64');
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', data, { filename });
        const response = await axios_1.default.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
            headers: {
                ...form.getHeaders(),
                'pinata_api_key': this.pinataKey,
                'pinata_secret_api_key': this.pinataSecret,
            },
        });
        return response.data.IpfsHash;
    }
    async ipfsRetrieve(cid, retries = 3) {
        let url = `https://gateway.pinata.cloud/ipfs/${cid}`;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await axios_1.default.get(url, { timeout: 15000, responseType: 'arraybuffer' });
                return buffer_1.Buffer.from(response.data).toString('base64');
            }
            catch (e) {
                if (i === retries - 1) {
                    url = `https://ipfs.io/ipfs/${cid}`;
                    const fallback = await axios_1.default.get(url, { timeout: 15000, responseType: 'arraybuffer' });
                    return buffer_1.Buffer.from(fallback.data).toString('base64');
                }
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
        throw new NovaError('IPFS retrieve failed');
    }
    computeHash(data) {
        return crypto.createHash('sha256').update(data).digest();
    }
}
exports.NovaSdk = NovaSdk;

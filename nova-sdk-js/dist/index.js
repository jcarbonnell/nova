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
const ed25519 = __importStar(require("@noble/ed25519"));
const sha2_js_1 = require("@noble/hashes/sha2.js");
const bs58_1 = __importDefault(require("bs58"));
// Set sha512 for noble/ed25519
ed25519.hashes.sha512 = sha2_js_1.sha512;
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
    privateKeyStr;
    contractId;
    pinataKey;
    pinataSecret;
    shadeApiUrl;
    constructor(rpcUrl, contractId, pinataKey, pinataSecret, shadeApiUrl) {
        this.provider = new providers_1.JsonRpcProvider({ url: rpcUrl });
        this.contractId = contractId;
        this.pinataKey = pinataKey;
        this.pinataSecret = pinataSecret;
        this.shadeApiUrl = shadeApiUrl;
    }
    async withSigner(privateKey, accountId) {
        try {
            this.privateKeyStr = privateKey;
            const keyPair = crypto_1.KeyPair.fromString(privateKey);
            const signer = new signers_1.KeyPairSigner(keyPair);
            this.account = new accounts_1.Account(accountId, this.provider, signer);
            return this;
        }
        catch (e) {
            throw new NovaError('Signing error', e);
        }
    }
    async getBalance(accountId) {
        try {
            // Use provider.viewAccount for read-only account state
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
            const decoded = buffer_1.Buffer.from(callResult.result).toString().trim();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async getGroupChecksum(groupId) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_group_checksum',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString().trim();
            return decoded ? JSON.parse(decoded) : null;
        }
        catch (e) {
            throw new NovaError(`Checksum fetch error: ${e}`, e);
        }
    }
    async getGroupOwner(groupId) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_group_owner',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString().trim();
            return decoded ? JSON.parse(decoded) : null; // Returns owner AccountId string
        }
        catch (e) {
            throw new NovaError(`Owner fetch error: ${e}`, e);
        }
    }
    async updateChecksum(groupId, checksum) {
        if (!this.account)
            throw new NovaError('No signer attached (must be group owner)');
        try {
            const result = await this.account.callFunction({
                contractId: this.contractId,
                methodName: 'update_checksum',
                args: { group_id: groupId, checksum },
                gas: 50000000000000n, // 50 TGas
                deposit: 10000000000000000000n, // 0.00001 NEAR
            });
            return result ? result.toString() : 'Success (group owner only)';
        }
        catch (e) {
            throw new NovaError(`Checksum update error: ${e} (ensure caller is group owner)`, e);
        }
    }
    async getGroupKey(groupId, userId) {
        if (!this.account || !this.privateKeyStr)
            throw new NovaError('No signer attached');
        try {
            // Step 1: Generate payload
            const timestamp = BigInt(Date.now()) * 1000000n; // ms to ns
            const nonceInput = `${groupId}${userId}${timestamp}`;
            const nonceHash = crypto.createHash('sha256').update(nonceInput).digest();
            const nonce = nonceHash.toString('hex');
            // Derive ed25519 public key from private (seed[:32])
            let seedBytes;
            if (this.privateKeyStr.startsWith('ed25519:')) {
                const seedB58 = this.privateKeyStr.slice(8);
                const seedBytesFull = buffer_1.Buffer.from(bs58_1.default.decode(seedB58));
                seedBytes = buffer_1.Buffer.from(seedBytesFull.subarray(0, 32));
            }
            else {
                throw new NovaError('Invalid private key format');
            }
            const publicBytes = ed25519.getPublicKey(new Uint8Array(seedBytes));
            const signingPkB58 = bs58_1.default.encode(publicBytes);
            const payloadDict = {
                group_id: groupId,
                user_id: userId,
                nonce: nonce,
                timestamp: Number(timestamp), // JSON can't handle BigInt
                signing_pk_b58: signingPkB58
            };
            const payloadStr = JSON.stringify(payloadDict);
            const payloadBytes = buffer_1.Buffer.from(payloadStr);
            const payloadB64 = payloadBytes.toString('base64');
            // Step 2: Sign raw payload bytes
            const sigBytes = ed25519.sign(payloadBytes, seedBytes);
            const sigHex = buffer_1.Buffer.from(sigBytes).toString('hex');
            // Step 3: Claim token on-chain
            const claimResult = await this.account.callFunction({
                contractId: this.contractId,
                methodName: 'claim_token',
                args: {
                    group_id: groupId,
                    payload_b64: payloadB64,
                    signature_hex: sigHex
                },
                gas: 100000000000000n,
                deposit: 1000000000000000000n // 0.001 NEAR
            });
            if (!claimResult)
                throw new NovaError('Token claim failed');
            // Parse returned token (base64-decoded str)
            const tokenB64 = claimResult.toString(); // Adjust based on actual return
            if (!tokenB64)
                throw new NovaError('Empty token from claim');
            const tokenBytes = buffer_1.Buffer.from(tokenB64, 'base64');
            const token = tokenBytes.toString('utf-8').replace(/"/g, '').trim(); // Strip quotes
            // Step 4: Fetch key from Shade API
            if (!this.shadeApiUrl)
                throw new NovaError('Shade API URL not set');
            const shadeResponse = await axios_1.default.post(`${this.shadeApiUrl}/api/key-management/get_key`, {
                group_id: groupId,
                token: token
            }, { timeout: 15000 });
            if (shadeResponse.status !== 200) {
                throw new NovaError(`Shade fetch failed: ${shadeResponse.statusText}`);
            }
            const shadeData = shadeResponse.data;
            const key = shadeData.key;
            const checksum = shadeData.checksum;
            // Step 5: Verify checksum on-chain (new: add here for explicit sequencing)
            const onChainChecksum = await this.getGroupChecksum(groupId);
            if ((onChainChecksum || '').trim() !== (checksum || '').trim()) {
                throw new NovaError('Checksum mismatch: Shade attestation invalid');
            }
            return key;
        }
        catch (e) {
            throw new NovaError(`Shade key fetch error: ${e}`, e);
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
    async executeContractCall(methodName, args, depositYocto) {
        if (!this.account)
            throw new NovaError('No signer attached');
        try {
            const result = await this.account.callFunction({
                contractId: this.contractId,
                methodName,
                args,
                gas: 300000000000000n,
                deposit: BigInt(depositYocto),
            });
            return result ? result.toString() : 'Success';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async registerGroup(groupId) {
        // Caller (signer) becomes group owner automatically
        return this.executeContractCall('register_group', { group_id: groupId }, '100000000000000000000000');
    }
    async addGroupMember(groupId, userId) {
        // Must be signed as group owner
        return this.executeContractCall('add_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    async revokeGroupMember(groupId, userId) {
        // Must be signed as group owner
        return this.executeContractCall('revoke_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    async recordTransaction(groupId, userId, fileHash, ipfsHash) {
        const result = await this.executeContractCall('record_transaction', {
            group_id: groupId,
            user_id: userId,
            file_hash: fileHash,
            ipfs_hash: ipfsHash,
        }, '2000000000000000000000');
        return result;
    }
    async transferTokens(toAccount, amountYocto) {
        if (!this.account)
            throw new NovaError('No signer attached');
        try {
            await this.account.transfer({ receiverId: toAccount, amount: BigInt(amountYocto) });
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async compositeUpload(groupId, userId, data, filename) {
        // Any authorized user (including group owner) can record
        const keyB64 = await this.getGroupKey(groupId, userId);
        const encryptedB64 = this.encryptData(data, keyB64);
        const cid = await this.ipfsUpload(encryptedB64, filename);
        const fileHash = this.computeHash(data).toString('hex');
        const transId = await this.recordTransaction(groupId, userId, fileHash, cid);
        return { cid, trans_id: transId, file_hash: fileHash };
    }
    async compositeRetrieve(groupId, ipfsHash) {
        if (!ipfsHash.startsWith('Qm'))
            throw new NovaError(`Invalid CID: ${ipfsHash}`);
        const userId = this.account.accountId;
        const keyB64 = await this.getGroupKey(groupId, userId);
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
        const iv = Uint8Array.prototype.slice.call(encrypted, 0, 16);
        const ciphertext = Uint8Array.prototype.slice.call(encrypted, 16);
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

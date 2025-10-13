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
    contractId;
    pinataKey;
    pinataSecret;
    constructor(rpcUrl, contractId, pinataKey, pinataSecret) {
        this.provider = new providers_1.JsonRpcProvider({ url: rpcUrl });
        this.contractId = contractId;
        this.pinataKey = pinataKey;
        this.pinataSecret = pinataSecret;
    }
    async withSigner(privateKey, accountId) {
        try {
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
            const decoded = buffer_1.Buffer.from(callResult.result).toString();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async getGroupKey(groupId, userId) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_group_key',
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
            const result = await this.account.functionCall({
                contractId: this.contractId,
                methodName,
                args,
                gas: 300000000000000n,
                attachedDeposit: BigInt(depositYocto),
            });
            return result ? 'Success' : 'No result';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async registerGroup(groupId) {
        return this.executeContractCall('register_group', { group_id: groupId }, '100000000000000000000000');
    }
    async addGroupMember(groupId, userId) {
        return this.executeContractCall('add_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    async revokeGroupMember(groupId, userId) {
        return this.executeContractCall('revoke_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
    }
    async storeGroupKey(groupId, keyB64) {
        return this.executeContractCall('store_group_key', { group_id: groupId, key: keyB64 }, '500000000000000000');
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
            await this.account.sendMoney(toAccount, BigInt(amountYocto));
            return 'Success';
        }
        catch (e) {
            throw new NovaError(`Near RPC error: ${e}`, e);
        }
    }
    async compositeUpload(groupId, userId, data, filename) {
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

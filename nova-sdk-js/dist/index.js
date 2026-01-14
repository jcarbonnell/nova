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
// nova/nova-sdk-js/src/index.ts
const providers_1 = require("@near-js/providers");
const axios_1 = __importDefault(require("axios"));
const crypto = __importStar(require("crypto"));
const buffer_1 = require("buffer");
// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://nova-mcp.fastmcp.app';
const DEFAULT_RPC_URL = 'https://rpc.mainnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk.near';
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
    sessionToken;
    accountId;
    contractId;
    mcpUrl;
    rpcUrl;
    networkId;
    constructor(accountId, config) {
        if (!accountId || typeof accountId !== 'string') {
            throw new NovaError('accountId required: get yours at nova-sdk.com');
        }
        if (!config?.sessionToken) {
            throw new NovaError('sessionToken required: get yours at nova-sdk.com/api/auth/session-token');
        }
        this.accountId = accountId;
        this.sessionToken = config.sessionToken;
        this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
        this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
        this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
        this.provider = new providers_1.JsonRpcProvider({ url: this.rpcUrl });
        // Auto-detect network
        this.networkId = this.detectNetwork();
        // Validate mainnet contract
        if (this.networkId === 'mainnet' && !this.isValidMainnetContract()) {
            throw new NovaError(`Invalid mainnet contract: ${this.contractId}. Must end with .near or .mainnet`);
        }
        if (this.networkId === 'mainnet') {
            console.warn('⚠️  MAINNET MODE: Operations use real NEAR tokens.');
            console.warn('📋 Contract:', this.contractId);
            console.warn('💰 Check costs at: https://nova-sdk.com/pricing');
        }
    }
    // Network detection
    detectNetwork() {
        // Heuristic 1: Contract ID suffix
        if (this.contractId.endsWith('.testnet'))
            return 'testnet';
        if (this.contractId.endsWith('.near') || this.contractId.endsWith('.mainnet')) {
            return 'mainnet';
        }
        // Heuristic 2: RPC URL
        if (this.rpcUrl.includes('testnet'))
            return 'testnet';
        if (this.rpcUrl.includes('mainnet'))
            return 'mainnet';
        // Default to mainnet for safety (v1.0.0+)
        console.warn('⚠️  Network auto-detection failed, defaulting to mainnet');
        return 'mainnet';
    }
    isValidMainnetContract() {
        return this.contractId.endsWith('.near') || this.contractId.endsWith('.mainnet');
    }
    // Get network info (for debugging)
    getNetworkInfo() {
        return {
            networkId: this.networkId,
            contractId: this.contractId,
            rpcUrl: this.rpcUrl,
            mcpUrl: this.mcpUrl,
        };
    }
    // Build HTTP headers for MCP server authentication. 
    // Includes JWT session token for ownership verification.
    getMcpHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.sessionToken}`,
            'X-Account-Id': this.accountId,
        };
    }
    // MCP Tool Invocations - Call an MCP tool directly.
    async callMcpTool(toolName, args) {
        try {
            const response = await axios_1.default.post(`${this.mcpUrl}/tools/${toolName}`, args, {
                headers: this.getMcpHeaders(),
                timeout: 60000, // 60s for composite operations
            });
            return response.data;
        }
        catch (e) {
            if (axios_1.default.isAxiosError(e)) {
                const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
                throw new NovaError(`MCP tool '${toolName}' failed: ${errorMsg}`, e);
            }
            throw new NovaError(`MCP tool '${toolName}' failed: ${e}`, e);
        }
    }
    // Core NOVA Operations (via MCP)
    // Check authentication status and group authorization.
    async authStatus(groupId = 'default') {
        return this.callMcpTool('auth_status', { group_id: groupId });
    }
    // Register a new group. Caller becomes owner.
    async registerGroup(groupId) {
        const result = await this.callMcpTool('register_group', {
            group_id: groupId
        });
        return result.message || `Group '${groupId}' registered successfully`;
    }
    // Add a member to a group. Caller must be owner.
    async addGroupMember(groupId, memberId) {
        const result = await this.callMcpTool('add_group_member', {
            group_id: groupId,
            member_id: memberId,
        });
        return result.message || `Added ${memberId} to group '${groupId}'`;
    }
    // Revoke a member from a group. Caller must be owner.
    async revokeGroupMember(groupId, memberId) {
        const result = await this.callMcpTool('revoke_group_member', {
            group_id: groupId,
            member_id: memberId,
        });
        return result.message || `Revoked ${memberId} from group '${groupId}'`;
    }
    // Upload encrypted file to IPFS and record on NEAR blockchain.
    // MCP server handles: key retrieval, encryption, IPFS upload, transaction signing.
    async compositeUpload(groupId, data, filename, payloadB64, sigHex) {
        const dataB64 = data.toString('base64');
        // For MCP v3, the server handles signing internally
        const finalPayloadB64 = payloadB64 || '';
        const finalSigHex = sigHex || '';
        return this.callMcpTool('composite_upload', {
            group_id: groupId,
            user_id: this.accountId,
            data: dataB64,
            filename,
            payload_b64: finalPayloadB64,
            sig_hex: finalSigHex,
        });
    }
    // Retrieve and decrypt file from IPFS.
    // MCP server handles: key retrieval, IPFS fetch, decryption.
    async compositeRetrieve(groupId, ipfsHash, payloadB64, sigHex) {
        if (!ipfsHash.startsWith('Qm')) {
            throw new NovaError(`Invalid CID: ${ipfsHash}`);
        }
        // For MCP, server handles signing
        const finalPayloadB64 = payloadB64 || '';
        const finalSigHex = sigHex || '';
        const result = await this.callMcpTool('composite_retrieve', {
            group_id: groupId,
            ipfs_hash: ipfsHash,
            payload_b64: finalPayloadB64,
            sig_hex: finalSigHex,
        });
        return {
            data: buffer_1.Buffer.from(result.decrypted_b64, 'base64'),
            file_hash: result.file_hash,
            fee_breakdown: result.fee_breakdown,
            ipfs_hash: result.ipfs_hash,
            group_id: result.group_id,
        };
    }
    // Read-Only Contract Queries (Direct RPC - no auth needed)
    async getBalance(accountId) {
        const id = accountId || this.accountId;
        try {
            const accountView = await this.provider.viewAccount(id);
            return accountView.amount.toString();
        }
        catch (e) {
            throw new NovaError(`Balance query error: ${e}`, e);
        }
    }
    async isAuthorized(groupId, userId) {
        const id = userId || this.accountId;
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'is_authorized',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId, user_id: id })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString().trim();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Authorization check error: ${e}`, e);
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
            return decoded ? JSON.parse(decoded) : null;
        }
        catch (e) {
            throw new NovaError(`Owner fetch error: ${e}`, e);
        }
    }
    async estimateFee(action) {
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'estimate_fee',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ action })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString().trim();
            return BigInt(decoded);
        }
        catch (e) {
            throw new NovaError(`Fee estimate error: ${e}`, e);
        }
    }
    async getTransactionsForGroup(groupId, userId) {
        const id = userId || this.accountId;
        try {
            const result = await this.provider.query({
                request_type: 'call_function',
                account_id: this.contractId,
                method_name: 'get_transactions_for_group',
                args_base64: buffer_1.Buffer.from(JSON.stringify({ group_id: groupId, user_id: id })).toString('base64'),
                finality: 'final',
            });
            const callResult = result;
            const decoded = buffer_1.Buffer.from(callResult.result).toString();
            return JSON.parse(decoded);
        }
        catch (e) {
            throw new NovaError(`Transactions query error: ${e}`, e);
        }
    }
    // Utility Method: Compute SHA256 hash of data.
    computeHash(data) {
        return crypto.createHash('sha256').update(data).digest('hex');
    }
}
exports.NovaSdk = NovaSdk;

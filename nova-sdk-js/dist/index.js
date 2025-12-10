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
const SHADE_API_URL = 'https://111507d14bb0a0c60d28a61bf6a973ccf4691a36-3000.dstack-prod5.phala.network';
const DEFAULT_RPC_URL = 'https://rpc.testnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk-5.testnet';
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
    userIdentifier;
    contractId;
    mcpUrl;
    shadeUrl;
    rpcUrl;
    constructor(userIdOrConfig, config) {
        this.userIdentifier = userIdOrConfig;
        this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
        this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
        this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
        this.shadeUrl = config?.shadeUrl || SHADE_API_URL;
        this.provider = new providers_1.JsonRpcProvider({ url: this.rpcUrl });
        // Validate user identifier
        if (!this.userIdentifier.email && !this.userIdentifier.walletId && !this.userIdentifier.accountId) {
            throw new NovaError('User identifier required: provide email, walletId, or accountId');
        }
    }
    // User Context Management
    // Get the NOVA account ID for this user.
    async getAccountId() {
        if (this.userIdentifier.accountId) {
            return this.userIdentifier.accountId;
        }
        // Resolve from Shade TEE
        const resolved = await this.resolveUserAccount();
        if (!resolved.accountId) {
            throw new NovaError('No NOVA account found. Please create an account at nova-sdk.com first.');
        }
        this.userIdentifier.accountId = resolved.accountId;
        return resolved.accountId;
    }
    // Resolve user's NOVA account from Shade TEE using email or wallet_id.
    async resolveUserAccount() {
        const payload = {};
        if (this.userIdentifier.walletId) {
            payload.wallet_id = this.userIdentifier.walletId;
        }
        else if (this.userIdentifier.email) {
            payload.email = this.userIdentifier.email;
            if (this.userIdentifier.authToken) {
                payload.auth_token = this.userIdentifier.authToken;
            }
        }
        else {
            throw new NovaError('Cannot resolve account: no email or walletId provided');
        }
        try {
            const response = await axios_1.default.post(`${this.shadeUrl}/api/user-keys/check`, payload, {
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' },
            });
            if (response.data.exists) {
                return {
                    accountId: response.data.account_id,
                    publicKey: response.data.public_key,
                    network: response.data.network,
                };
            }
            return {};
        }
        catch (e) {
            if (axios_1.default.isAxiosError(e) && e.response?.status === 404) {
                return {};
            }
            throw new NovaError(`Failed to resolve user account: ${e}`, e);
        }
    }
    // Build HTTP headers for MCP server authentication.
    getMcpHeaders() {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.userIdentifier.authToken) {
            headers['Authorization'] = `Bearer ${this.userIdentifier.authToken}`;
        }
        if (this.userIdentifier.email) {
            headers['X-User-Email'] = this.userIdentifier.email;
        }
        if (this.userIdentifier.walletId) {
            headers['X-Wallet-Id'] = this.userIdentifier.walletId;
        }
        if (this.userIdentifier.accountId) {
            headers['X-Account-Id'] = this.userIdentifier.accountId;
        }
        return headers;
    }
    // MCP Tool Invocations - Call an MCP tool directly.
    async callMcpTool(toolName, args) {
        // Ensure we have account ID resolved
        if (!this.userIdentifier.accountId) {
            await this.getAccountId();
        }
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
        const accountId = await this.getAccountId();
        const dataB64 = data.toString('base64');
        // If payload/sig not provided, generate them (requires local signing capability)
        let finalPayloadB64 = payloadB64;
        let finalSigHex = sigHex;
        if (!finalPayloadB64 || !finalSigHex) {
            // For MCP v3, the server can handle signing internally
            // We pass empty strings and let MCP use get_user_signer()
            finalPayloadB64 = '';
            finalSigHex = '';
        }
        return this.callMcpTool('composite_upload', {
            group_id: groupId,
            user_id: accountId,
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
        // For MCP v3, server handles signing
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
        const id = accountId || await this.getAccountId();
        try {
            const accountView = await this.provider.viewAccount(id);
            return accountView.amount.toString();
        }
        catch (e) {
            throw new NovaError(`Balance query error: ${e}`, e);
        }
    }
    async isAuthorized(groupId, userId) {
        const id = userId || await this.getAccountId();
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
        const id = userId || await this.getAccountId();
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

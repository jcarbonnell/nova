"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NovaSdk = exports.decryptV0 = exports.encryptV0 = exports.decodeFile = exports.encodeFile = exports.NovaError = void 0;
// nova/nova-sdk-js/src/index.ts
const providers_1 = require("@near-js/providers");
const axios_1 = __importDefault(require("axios"));
const buffer_1 = require("buffer");
// NovaError moved to ./errors.js; re-exported below so the public API is unchanged.
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "NovaError", { enumerable: true, get: function () { return errors_js_1.NovaError; } });
const errors_js_2 = require("./errors.js");
// File-format codec (v0 legacy + v1) and the version dispatcher.
var format_js_1 = require("./format.js");
Object.defineProperty(exports, "encodeFile", { enumerable: true, get: function () { return format_js_1.encodeFile; } });
Object.defineProperty(exports, "decodeFile", { enumerable: true, get: function () { return format_js_1.decodeFile; } });
const format_js_2 = require("./format.js");
var v0_js_1 = require("./legacy/v0.js");
Object.defineProperty(exports, "encryptV0", { enumerable: true, get: function () { return v0_js_1.encryptV0; } });
Object.defineProperty(exports, "decryptV0", { enumerable: true, get: function () { return v0_js_1.decryptV0; } });
// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const DEFAULT_RPC_URL = 'https://rpc.mainnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk.near';
const DEFAULT_AUTH_URL = 'https://nova-sdk.com';
function computeSha256(data) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
}
async function computeSha256Async(data) {
    if (typeof globalThis.crypto?.subtle !== 'undefined') {
        // Create a plain ArrayBuffer copy to avoid TypeScript issues with Buffer's ArrayBufferLike
        const dataArrayBuffer = new ArrayBuffer(data.length);
        const dataView = new Uint8Array(dataArrayBuffer);
        for (let i = 0; i < data.length; i++) {
            dataView[i] = data[i];
        }
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', dataArrayBuffer);
        return buffer_1.Buffer.from(hashBuffer).toString('hex');
    }
    // Node.js fallback
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(data).digest('hex');
}
// Main SDK Class
class NovaSdk {
    provider;
    tokenCache = null;
    authUrl;
    apiKey = null;
    accountId;
    contractId;
    mcpUrl;
    rpcUrl;
    networkId;
    /**
     * Create a new NOVA SDK instance.
     *
     * @param accountId - Your NOVA account (e.g., "alice.nova-sdk.near")
     * @param config - Optional configuration. If sessionToken is not provided,
     *                 the SDK will automatically fetch and refresh tokens.
     *
     * @example
     * // Simplest usage - auto token management
     * const sdk = new NovaSdk('alice.nova-sdk.near');
     *
     * @example
     * // With pre-fetched token
     * const sdk = new NovaSdk('alice.nova-sdk.near', { sessionToken: 'eyJ...' });
     *
     * @example
     * // mainnet configuration
     * const sdk = new NovaSdk('alice.nova-sdk.near', {
     *   rpcUrl: 'https://rpc.mainnet.near.org',
     *   contractId: 'nova-sdk.near',
     * });
     */
    constructor(accountId, config = {}) {
        if (!accountId || typeof accountId !== 'string') {
            throw new errors_js_2.NovaError('accountId required: get yours at nova-sdk.com');
        }
        this.accountId = accountId;
        this.authUrl = config.authUrl || DEFAULT_AUTH_URL;
        this.apiKey = config.apiKey || null;
        this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
        this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
        this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
        this.provider = new providers_1.JsonRpcProvider({ url: this.rpcUrl });
        // Auto-detect network
        this.networkId = this.detectNetwork();
        // Validate mainnet contract
        if (this.networkId === 'mainnet' && !this.isValidMainnetContract()) {
            throw new errors_js_2.NovaError(`Invalid mainnet contract: ${this.contractId}. Must end with .near`);
        }
        if (this.networkId === 'mainnet') {
            console.warn('⚠️  MAINNET MODE: Operations use real NEAR tokens.');
            console.warn('📋 Contract:', this.contractId);
            console.warn('💰 Check costs at: https://github.com/jcarbonnell/nova');
        }
    }
    // Token Management (auto-fetch and refresh)
    /**
     * Get a valid session token, fetching or refreshing if needed.
     * Called automatically before each API request.
     */
    async getSessionToken() {
        // Return cached token if still valid (5 min buffer for safety)
        if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
            return this.tokenCache.token;
        }
        // Fetch new token
        console.log('🔑 Fetching session token for:', this.accountId);
        if (!this.apiKey) {
            throw new errors_js_2.NovaError('API key required. Get yours at nova-sdk.com');
        }
        try {
            const response = await axios_1.default.post(`${this.authUrl}/api/auth/session-token`, { account_id: this.accountId }, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.apiKey,
                },
                timeout: 15000,
            });
            const { token, expires_in, account_id } = response.data;
            if (!token) {
                throw new errors_js_2.NovaError('No token in response - account may not exist');
            }
            // Verify account_id matches
            if (account_id && account_id !== this.accountId) {
                console.warn(`Account ID mismatch: requested ${this.accountId}, got ${account_id}`);
            }
            // Parse expires_in (e.g., "24h")
            const expiresMs = this.parseExpiry(expires_in || '24h');
            this.tokenCache = {
                token,
                expiresAt: Date.now() + expiresMs,
            };
            console.log('✅ Session token obtained, expires in:', expires_in || '24h');
            return token;
        }
        catch (e) {
            if (axios_1.default.isAxiosError(e)) {
                const status = e.response?.status;
                const msg = e.response?.data?.error || e.message;
                if (status === 404) {
                    throw new errors_js_2.NovaError(`Account '${this.accountId}' not found. Create one at nova-sdk.com first.`, e);
                }
                throw new errors_js_2.NovaError(`Failed to get session token: ${msg}`, e);
            }
            throw new errors_js_2.NovaError(`Failed to get session token: ${e}`, e);
        }
    }
    parseExpiry(expiresIn) {
        const match = expiresIn.match(/^(\d+)([hmd])$/);
        if (!match)
            return 23 * 60 * 60 * 1000; // Default 23h
        const value = parseInt(match[1]);
        const unit = match[2];
        switch (unit) {
            case 'h': return value * 60 * 60 * 1000;
            case 'm': return value * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: return 23 * 60 * 60 * 1000;
        }
    }
    /**
     * Force refresh the session token.
     * Useful if you get auth errors and want to retry with a fresh token.
     */
    async refreshToken() {
        this.tokenCache = null;
        await this.getSessionToken();
    }
    // Network detection
    detectNetwork() {
        if (this.contractId.endsWith('.testnet'))
            return 'testnet';
        if (this.contractId.endsWith('.near'))
            return 'mainnet';
        if (this.rpcUrl.includes('testnet'))
            return 'testnet';
        if (this.rpcUrl.includes('mainnet'))
            return 'mainnet';
        // Default to mainnet
        console.warn('⚠️  Network auto-detection failed, defaulting to mainnet');
        return 'mainnet';
    }
    isValidMainnetContract() {
        return this.contractId.endsWith('.near');
    }
    // Get network info (for debugging)
    getNetworkInfo() {
        return {
            networkId: this.networkId,
            contractId: this.contractId,
            rpcUrl: this.rpcUrl,
            mcpUrl: this.mcpUrl,
            authUrl: this.authUrl,
        };
    }
    // MCP Communication 
    async getMcpHeaders() {
        const token = await this.getSessionToken();
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'x-account-id': this.accountId,
            'x-wallet-id': this.accountId,
        };
    }
    // MCP Tool Invocations - Call an MCP tool directly.
    async callMcpTool(toolName, args) {
        try {
            const headers = await this.getMcpHeaders();
            const response = await axios_1.default.post(`${this.mcpUrl}/tools/${toolName}`, args, { headers, timeout: 60000 });
            // Unwrap { result: ... } envelope added by expose_as_rest decorator
            const data = response.data;
            if (data && typeof data === 'object' && 'result' in data) {
                return data.result;
            }
            return data;
        }
        catch (e) {
            if (axios_1.default.isAxiosError(e)) {
                const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
                throw new errors_js_2.NovaError(`MCP tool '${toolName}' failed: ${errorMsg}`, e);
            }
            throw new errors_js_2.NovaError(`MCP tool '${toolName}' failed: ${e}`, e);
        }
    }
    // Core NOVA Operations (via MCP)
    // Check authentication status and group authorization.
    async authStatus(groupId = 'default') {
        return this.callMcpTool('auth_status', { group_id: groupId });
    }
    // List groups the authenticated account owns. Routed through MCP: the owning
    // account is derived from the verified session (no arg passed, so no
    // client-supplied account can be spoofed). Returns [] when none are owned.
    async getOwnedGroups() {
        return this.callMcpTool('get_owned_groups', {});
    }
    // List groups the authenticated account is a member of. Same MCP-session
    // identity model as getOwnedGroups. Returns [] when a member of none.
    async getMemberGroups() {
        return this.callMcpTool('get_member_groups', {});
    }
    // List the members of a group. Routed through MCP because the underlying
    // contract read is authorization-gated; an unauthorized caller is rejected by
    // the contract and surfaced here as a NovaError. Caller must be authorized
    // on the group.
    async getGroupMembers(groupId) {
        return this.callMcpTool('get_group_members', { group_id: groupId });
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
    // Set (or clear, with null) a group's retention window in days (§6.1). Owner only.
    // null ⇒ no auto-expiry (the default). Files past the window become eligible for
    // retention-driven deletion; this configures the window only, it deletes nothing.
    async setGroupRetention(groupId, retentionDays) {
        const result = await this.callMcpTool('set_group_retention', {
            group_id: groupId,
            retention_days: retentionDays,
        });
        return result.message || (retentionDays === null
            ? `Cleared retention for group '${groupId}'`
            : `Set retention for group '${groupId}' to ${retentionDays} days`);
    }
    /**
     * Self-join an OPEN group (hackathon submission groups). The caller joins
     * themselves — no owner action needed. Only works on groups the owner has
     * opened for join; otherwise the contract rejects it.
     *
     * Idempotent-safe: if already a member, resolves without error rather than
     * throwing on the contract's "Already a member" panic.
     */
    async joinGroup(groupId) {
        // Skip the join if already authorized — avoids the contract's
        // "Already a member" panic on re-submit.
        try {
            if (await this.isAuthorized(groupId)) {
                return `Already a member of '${groupId}'`;
            }
        }
        catch {
            // isAuthorized can throw if the group doesn't exist yet; let join surface it.
        }
        const result = await this.callMcpTool('join_group', {
            group_id: groupId,
        });
        if (typeof result === 'string')
            return result;
        return result.message || `Joined group '${groupId}'`;
    }
    // Revoke a member from a group. Caller must be owner.
    async revokeGroupMember(groupId, memberId) {
        const result = await this.callMcpTool('revoke_group_member', {
            group_id: groupId,
            member_id: memberId,
        });
        return result.message || `Revoked ${memberId} from group '${groupId}'`;
    }
    /**
     * Upload a file with end-to-end encryption
     *
     * Flow:
     * 1. SDK calls prepare_upload to get encryption key
     * 2. SDK encrypts data locally (AES-256-GCM)
     * 3. SDK calls finalize_upload with encrypted data
     * 4. MCP uploads to IPFS and records on NEAR
     *
     * @param groupId - The group to upload to
     * @param data - Raw file data as Buffer
     * @param filename - Name of the file
     * @returns Upload result with CID and transaction ID
     */
    async upload(groupId, data, filename) {
        // Step 1: Get encryption key from MCP
        const prepareResult = await this.callMcpTool('prepare_upload', {
            group_id: groupId,
            filename,
        });
        const { upload_id, key } = prepareResult;
        // Step 2: Encode to the v1 format (optional deflate + v0 AES-GCM) with the
        // per-file key from prepare_upload. `format` is persisted by Shade and returned
        // at retrieve so decodeFile can dispatch.
        const { bytes_b64, format } = await (0, format_js_2.encodeFile)(data, key);
        // Step 3: Compute hash of PLAINTEXT (the on-chain integrity anchor — unchanged).
        const fileHash = await computeSha256Async(data);
        // Step 4: Finalize upload via MCP tool
        const finalizeResult = await this.callMcpTool('finalize_upload', {
            upload_id,
            encrypted_data: bytes_b64,
            file_hash: fileHash,
            format,
        });
        return {
            cid: finalizeResult.location ?? finalizeResult.cid,
            trans_id: finalizeResult.trans_id,
            file_hash: finalizeResult.file_hash,
        };
    }
    /**
     * Retrieve and decrypt a file
     *
     * Flow:
     * 1. Call prepare_retrieve to get key and encrypted data
     * 2. Decrypt data locally (client-side)
     *
     * @param groupId - The group the file belongs to
     * @param ipfsHash - The IPFS CID of the file
     * @returns Decrypted file data
     */
    async retrieve(groupId, ref) {
        // `ref` is whatever the on-chain record stored: a legacy IPFS CID OR a FastFS
        // location ({pred}/{recv}/{rel}). No CID prefix guard — MCP dispatches, and a
        // malformed ref surfaces a clear error from the FastFS branch.
        if (!ref)
            throw new errors_js_2.NovaError('retrieve requires a file reference (CID or FastFS location)');
        // Step 1: Get key, ciphertext, and format from MCP
        const prepareResult = await this.callMcpTool('prepare_retrieve', {
            group_id: groupId,
            ipfs_hash: ref, // MCP's param is still named ipfs_hash; it carries the ref
        });
        const { key, encrypted_b64, ipfs_hash, group_id, format } = prepareResult;
        // Step 2: Decode locally — decodeFile dispatches on format (v1 FastFS vs v0
        // legacy). null/absent format ⇒ v0 legacy path (frozen decryptV0).
        const decryptedData = await (0, format_js_2.decodeFile)(encrypted_b64, key, format ?? null);
        return {
            data: decryptedData,
            ipfs_hash,
            group_id,
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
            throw new errors_js_2.NovaError(`Balance query error: ${e}`, e);
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
            throw new errors_js_2.NovaError(`Authorization check error: ${e}`, e);
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
            throw new errors_js_2.NovaError(`Checksum fetch error: ${e}`, e);
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
            throw new errors_js_2.NovaError(`Owner fetch error: ${e}`, e);
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
            throw new errors_js_2.NovaError(`Fee estimate error: ${e}`, e);
        }
    }
    // Routed through MCP (not direct RPC). The contract's get_transactions_for_group
    // is #[payable] + gated (is_authorized || owner), so a free view call panics
    // ("Attach at least … for fee"). MCP's get_group_transactions branches on
    // joinability: a joinable group uses the free public view; a private group uses
    // the signed, fee'd path (~0.0013 NEAR) and returns the list only to an
    // authorized member. The `userId` param is dropped — MCP derives identity from
    // the verified session, so a caller can't query as another account.
    async getTransactionsForGroup(groupId) {
        return this.callMcpTool('get_group_transactions', { group_id: groupId });
    }
    // Utility Methods
    /** Compute SHA256 hash of data (synchronous, Node.js only) */
    computeHash(data) {
        return computeSha256(data);
    }
    /** Compute SHA256 hash of data (async, works everywhere) */
    async computeHashAsync(data) {
        return computeSha256Async(data);
    }
    // Legacy Methods (deprecated)
    /** @deprecated Use upload() instead */
    async compositeUpload(groupId, data, filename) {
        console.warn('compositeUpload() is deprecated, use upload() instead');
        return this.upload(groupId, data, filename);
    }
    /** @deprecated Use retrieve() instead */
    async compositeRetrieve(groupId, ipfsHash) {
        console.warn('compositeRetrieve() is deprecated, use retrieve() instead');
        return this.retrieve(groupId, ipfsHash);
    }
}
exports.NovaSdk = NovaSdk;

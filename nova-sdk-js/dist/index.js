"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NovaSdk = exports.NovaError = void 0;
// nova/nova-sdk-js/src/index.ts
const providers_1 = require("@near-js/providers");
const axios_1 = __importDefault(require("axios"));
const buffer_1 = require("buffer");
// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://nova-mcp.fastmcp.app';
const DEFAULT_RPC_URL = 'https://rpc.mainnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk.near';
const DEFAULT_AUTH_URL = 'https://nova-sdk.com';
class NovaError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'NovaError';
    }
}
exports.NovaError = NovaError;
// encryption helpers (AES-256-GCM)
async function encryptData(data, keyB64) {
    // Node.js environment
    if (typeof globalThis.crypto?.subtle === 'undefined') {
        const crypto = await import('crypto');
        const keyBytes = buffer_1.Buffer.from(keyB64, 'base64');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
        const encrypted = buffer_1.Buffer.concat([cipher.update(data), cipher.final()]);
        const authTag = cipher.getAuthTag();
        // Format: IV (12) + ciphertext + authTag (16)
        const result = buffer_1.Buffer.concat([iv, encrypted, authTag]);
        return result.toString('base64');
    }
    // Browser/Deno: use SubtleCrypto
    const keyBytes = new Uint8Array(buffer_1.Buffer.from(keyB64, 'base64'));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    // Create a plain ArrayBuffer copy to avoid TypeScript issues with Buffer's ArrayBufferLike
    const dataArrayBuffer = new ArrayBuffer(data.length);
    const dataView = new Uint8Array(dataArrayBuffer);
    for (let i = 0; i < data.length; i++) {
        dataView[i] = data[i];
    }
    const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, dataArrayBuffer);
    // Combine IV + ciphertext (which includes auth tag in SubtleCrypto)
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return buffer_1.Buffer.from(result).toString('base64');
}
async function decryptData(encryptedB64, keyB64) {
    const encryptedBytes = buffer_1.Buffer.from(encryptedB64, 'base64');
    const keyBytes = buffer_1.Buffer.from(keyB64, 'base64');
    // For Node.js environment
    if (typeof globalThis.crypto?.subtle === 'undefined') {
        const crypto = await import('crypto');
        const iv = encryptedBytes.subarray(0, 12);
        const authTag = encryptedBytes.subarray(encryptedBytes.length - 16);
        const ciphertext = encryptedBytes.subarray(12, encryptedBytes.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
        decipher.setAuthTag(authTag);
        const decrypted = buffer_1.Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted;
    }
    // Browser/Deno: use SubtleCrypto
    const iv = encryptedBytes.subarray(0, 12);
    const ciphertext = encryptedBytes.subarray(12); // Includes auth tag
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
    return buffer_1.Buffer.from(decrypted);
}
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
            throw new NovaError('accountId required: get yours at nova-sdk.com');
        }
        this.accountId = accountId;
        this.authUrl = config.authUrl || DEFAULT_AUTH_URL;
        this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
        this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
        this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
        this.provider = new providers_1.JsonRpcProvider({ url: this.rpcUrl });
        // Token handling
        if (config.sessionToken) {
            // Pre-fetched token provided
            this.tokenCache = {
                token: config.sessionToken,
                expiresAt: Date.now() + 23 * 60 * 60 * 1000, // Assume ~23h remaining
            };
        }
        // Otherwise tokenCache stays null, will auto-fetch on first API call
        // Auto-detect network
        this.networkId = this.detectNetwork();
        // Validate mainnet contract
        if (this.networkId === 'mainnet' && !this.isValidMainnetContract()) {
            throw new NovaError(`Invalid mainnet contract: ${this.contractId}. Must end with .near`);
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
        try {
            const response = await axios_1.default.post(`${this.authUrl}/api/auth/session-token`, { account_id: this.accountId }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000,
            });
            const { token, expires_in, account_id } = response.data;
            if (!token) {
                throw new NovaError('No token in response - account may not exist');
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
                    throw new NovaError(`Account '${this.accountId}' not found. Create one at nova-sdk.com first.`, e);
                }
                throw new NovaError(`Failed to get session token: ${msg}`, e);
            }
            throw new NovaError(`Failed to get session token: ${e}`, e);
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
            'X-Account-Id': this.accountId,
        };
    }
    // MCP Tool Invocations - Call an MCP tool directly.
    async callMcpTool(toolName, args) {
        try {
            const headers = await this.getMcpHeaders();
            const response = await axios_1.default.post(`${this.mcpUrl}/tools/${toolName}`, args, { headers, timeout: 60000 });
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
    // HTTP endpoint call (for finalize_upload)
    async callHttpEndpoint(endpoint, body) {
        try {
            const headers = await this.getMcpHeaders();
            const response = await axios_1.default.post(`${this.mcpUrl}${endpoint}`, body, { headers, timeout: 60000 });
            return response.data;
        }
        catch (e) {
            if (axios_1.default.isAxiosError(e)) {
                const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
                throw new NovaError(`HTTP endpoint '${endpoint}' failed: ${errorMsg}`, e);
            }
            throw new NovaError(`HTTP endpoint '${endpoint}' failed: ${e}`, e);
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
        // Step 2: Encrypt data locally
        const encryptedB64 = await encryptData(data, key);
        // Step 3: Compute hash of plaintext
        const fileHash = await computeSha256Async(data);
        // Step 4: Finalize upload
        const finalizeResult = await this.callHttpEndpoint('/api/finalize-upload', {
            upload_id,
            encrypted_data: encryptedB64,
            file_hash: fileHash,
        });
        return {
            cid: finalizeResult.cid,
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
    async retrieve(groupId, ipfsHash) {
        if (!ipfsHash.startsWith('Qm') && !ipfsHash.startsWith('bafy')) {
            throw new NovaError(`Invalid CID: ${ipfsHash}`);
        }
        // Step 1: Get key and encrypted data from MCP
        const prepareResult = await this.callMcpTool('prepare_retrieve', {
            group_id: groupId,
            ipfs_hash: ipfsHash,
        });
        const { key, encrypted_b64, ipfs_hash, group_id } = prepareResult;
        // Step 2: Decrypt data locally
        const decryptedData = await decryptData(encrypted_b64, key);
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

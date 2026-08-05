import { Buffer } from 'buffer';
export { NovaError } from './errors.js';
export { encodeFile, decodeFile } from './format.js';
export type { FileFormat, FileFormatV1, CompressionAlgo, EncodeOptions } from './format.js';
export { encryptV0, decryptV0 } from './legacy/v0.js';
export interface NovaSdkConfig {
    apiKey?: string;
    authUrl?: string;
    rpcUrl?: string;
    contractId?: string;
    mcpUrl?: string;
}
export interface Transaction {
    group_id: string;
    user_id: string;
    file_hash: string;
    ipfs_hash: string;
}
export interface UploadResult {
    cid: string;
    trans_id: string;
    file_hash: string;
}
export interface RetrieveResult {
    data: Buffer;
    ipfs_hash: string;
    group_id: string;
}
export interface AuthStatusResult {
    authenticated: boolean;
    near_account_id?: string;
    authorized_for_group?: boolean;
}
export declare class NovaSdk {
    private provider;
    private tokenCache;
    private authUrl;
    private apiKey;
    readonly accountId: string;
    readonly contractId: string;
    readonly mcpUrl: string;
    readonly rpcUrl: string;
    readonly networkId: string;
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
    constructor(accountId: string, config?: NovaSdkConfig);
    /**
     * Get a valid session token, fetching or refreshing if needed.
     * Called automatically before each API request.
     */
    private getSessionToken;
    private parseExpiry;
    /**
     * Force refresh the session token.
     * Useful if you get auth errors and want to retry with a fresh token.
     */
    refreshToken(): Promise<void>;
    private detectNetwork;
    private isValidMainnetContract;
    getNetworkInfo(): {
        networkId: string;
        contractId: string;
        rpcUrl: string;
        mcpUrl: string;
        authUrl: string;
    };
    private getMcpHeaders;
    private callMcpTool;
    authStatus(groupId?: string): Promise<AuthStatusResult>;
    registerGroup(groupId: string): Promise<string>;
    addGroupMember(groupId: string, memberId: string): Promise<string>;
    /**
     * Self-join an OPEN group (hackathon submission groups). The caller joins
     * themselves — no owner action needed. Only works on groups the owner has
     * opened for join; otherwise the contract rejects it.
     *
     * Idempotent-safe: if already a member, resolves without error rather than
     * throwing on the contract's "Already a member" panic.
     */
    joinGroup(groupId: string): Promise<string>;
    revokeGroupMember(groupId: string, memberId: string): Promise<string>;
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
    upload(groupId: string, data: Buffer, filename: string): Promise<UploadResult>;
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
    retrieve(groupId: string, ref: string): Promise<RetrieveResult>;
    getBalance(accountId?: string): Promise<string>;
    isAuthorized(groupId: string, userId?: string): Promise<boolean>;
    getGroupChecksum(groupId: string): Promise<string | null>;
    getGroupOwner(groupId: string): Promise<string | null>;
    estimateFee(action: string): Promise<bigint>;
    getTransactionsForGroup(groupId: string, userId?: string): Promise<Transaction[]>;
    /** Compute SHA256 hash of data (synchronous, Node.js only) */
    computeHash(data: Buffer): string;
    /** Compute SHA256 hash of data (async, works everywhere) */
    computeHashAsync(data: Buffer): Promise<string>;
    /** @deprecated Use upload() instead */
    compositeUpload(groupId: string, data: Buffer, filename: string): Promise<UploadResult>;
    /** @deprecated Use retrieve() instead */
    compositeRetrieve(groupId: string, ipfsHash: string): Promise<RetrieveResult>;
}
//# sourceMappingURL=index.d.ts.map
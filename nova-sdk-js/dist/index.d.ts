import { Buffer } from 'buffer';
export interface NovaSdkConfig {
    sessionToken: string;
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
export interface FeeBreakdown {
    claim: number;
    record?: number;
    total: number;
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
export declare class NovaError extends Error {
    cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
export declare class NovaSdk {
    private provider;
    private sessionToken;
    readonly accountId: string;
    readonly contractId: string;
    readonly mcpUrl: string;
    readonly rpcUrl: string;
    readonly networkId: string;
    constructor(accountId: string, config: NovaSdkConfig);
    private detectNetwork;
    private isValidMainnetContract;
    getNetworkInfo(): {
        networkId: string;
        contractId: string;
        rpcUrl: string;
        mcpUrl: string;
    };
    private getMcpHeaders;
    private callMcpTool;
    private callHttpEndpoint;
    authStatus(groupId?: string): Promise<AuthStatusResult>;
    registerGroup(groupId: string): Promise<string>;
    addGroupMember(groupId: string, memberId: string): Promise<string>;
    revokeGroupMember(groupId: string, memberId: string): Promise<string>;
    /**
     * Upload a file to IPFS with encryption and blockchain recording.
     *
     * Flow:
     * 1. Call prepare_upload to get encryption key
     * 2. Encrypt data locally (client-side)
     * 3. Call finalize_upload with encrypted data
     *
     * @param groupId - The group to upload to
     * @param data - Raw file data as Buffer
     * @param filename - Name of the file
     * @returns Upload result with CID and transaction ID
     */
    upload(groupId: string, data: Buffer, filename: string): Promise<UploadResult>;
    /**
     * Retrieve and decrypt a file from IPFS.
     *
     * Flow:
     * 1. Call prepare_retrieve to get key and encrypted data
     * 2. Decrypt data locally (client-side)
     *
     * @param groupId - The group the file belongs to
     * @param ipfsHash - The IPFS CID of the file
     * @returns Decrypted file data
     */
    retrieve(groupId: string, ipfsHash: string): Promise<RetrieveResult>;
    /** @deprecated Use upload() instead */
    compositeUpload(groupId: string, data: Buffer, filename: string): Promise<UploadResult>;
    /** @deprecated Use retrieve() instead */
    compositeRetrieve(groupId: string, ipfsHash: string): Promise<RetrieveResult>;
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
}
//# sourceMappingURL=index.d.ts.map
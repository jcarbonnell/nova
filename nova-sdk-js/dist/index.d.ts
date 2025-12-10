import { Buffer } from 'buffer';
export interface UserIdentifier {
    email?: string;
    walletId?: string;
    accountId?: string;
    authToken?: string;
}
export interface NovaSdkConfig {
    rpcUrl?: string;
    contractId?: string;
    mcpUrl?: string;
    shadeUrl?: string;
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
export interface CompositeUploadResult {
    cid: string;
    trans_id: string;
    file_hash: string;
    fee_breakdown: FeeBreakdown;
}
export interface CompositeRetrieveResult {
    data: Buffer;
    file_hash: string;
    fee_breakdown: FeeBreakdown;
    ipfs_hash: string;
    group_id: string;
}
export interface AuthStatusResult {
    authenticated: boolean;
    email?: string;
    wallet_id?: string;
    near_account_id?: string;
    authorized_for_group?: boolean;
}
export declare class NovaError extends Error {
    cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
export declare class NovaSdk {
    private provider;
    private userIdentifier;
    readonly contractId: string;
    readonly mcpUrl: string;
    readonly shadeUrl: string;
    readonly rpcUrl: string;
    constructor(userIdOrConfig: UserIdentifier, config?: NovaSdkConfig);
    getAccountId(): Promise<string>;
    resolveUserAccount(): Promise<{
        accountId?: string;
        publicKey?: string;
        network?: string;
    }>;
    private getMcpHeaders;
    private callMcpTool;
    authStatus(groupId?: string): Promise<AuthStatusResult>;
    registerGroup(groupId: string): Promise<string>;
    addGroupMember(groupId: string, memberId: string): Promise<string>;
    revokeGroupMember(groupId: string, memberId: string): Promise<string>;
    compositeUpload(groupId: string, data: Buffer, filename: string, payloadB64?: string, sigHex?: string): Promise<CompositeUploadResult>;
    compositeRetrieve(groupId: string, ipfsHash: string, payloadB64?: string, sigHex?: string): Promise<CompositeRetrieveResult>;
    getBalance(accountId?: string): Promise<string>;
    isAuthorized(groupId: string, userId?: string): Promise<boolean>;
    getGroupChecksum(groupId: string): Promise<string | null>;
    getGroupOwner(groupId: string): Promise<string | null>;
    estimateFee(action: string): Promise<bigint>;
    getTransactionsForGroup(groupId: string, userId?: string): Promise<Transaction[]>;
    computeHash(data: Buffer): string;
}
//# sourceMappingURL=index.d.ts.map
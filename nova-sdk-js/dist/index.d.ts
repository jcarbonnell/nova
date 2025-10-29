import { Buffer } from 'buffer';
export interface Transaction {
    group_id: string;
    user_id: string;
    file_hash: string;
    ipfs_hash: string;
}
export interface CompositeUploadResult {
    cid: string;
    trans_id: string;
    file_hash: string;
}
export interface CompositeRetrieveResult {
    data: Buffer;
    file_hash: string;
}
export interface TokenPayload {
    group_id: string;
    user_id: string;
    nonce: string;
    timestamp: number;
    signing_pk_b58?: string;
}
export declare class NovaError extends Error {
    cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
export declare class NovaSdk {
    private provider;
    private account?;
    private privateKey?;
    contractId: string;
    shadeApiUrl?: string;
    pinataKey: string;
    pinataSecret: string;
    constructor(rpcUrl: string, contractId: string, pinataKey: string, pinataSecret: string, shadeApiUrl?: string);
    withSigner(privateKey: string, accountId: string): Promise<this>;
    getBalance(accountId: string): Promise<string>;
    isAuthorized(groupId: string, userId: string): Promise<boolean>;
    getGroupKey(groupId: string, userId: string): Promise<string>;
    getShadeKey(groupId: string, userId: string): Promise<string>;
    getTransactionsForGroup(groupId: string, userId: string): Promise<Transaction[]>;
    updateChecksum(groupId: string, checksum: string): Promise<string>;
    approveShadeCodeHash(codeHash: string): Promise<string>;
    registerShadeWorker(userId: string, attestation: Buffer): Promise<string>;
    getNonceValidity(groupId: string, userId: string, nonce: string): Promise<boolean>;
    requestSignature(path: string, payload: Buffer, keyType?: string): Promise<string>;
    private executeContractCall;
    registerGroup(groupId: string): Promise<string>;
    addGroupMember(groupId: string, userId: string): Promise<string>;
    revokeGroupMember(groupId: string, userId: string): Promise<string>;
    storeGroupKey(groupId: string, keyB64: string): Promise<string>;
    recordTransaction(groupId: string, userId: string, fileHash: string, ipfsHash: string): Promise<string>;
    transferTokens(toAccount: string, amountYocto: string): Promise<string>;
    compositeUpload(groupId: string, userId: string, data: Buffer, filename: string): Promise<CompositeUploadResult>;
    compositeRetrieve(groupId: string, ipfsHash: string): Promise<CompositeRetrieveResult>;
    private encryptData;
    private decryptData;
    private ipfsUpload;
    private ipfsRetrieve;
    private computeHash;
}
//# sourceMappingURL=index.d.ts.map
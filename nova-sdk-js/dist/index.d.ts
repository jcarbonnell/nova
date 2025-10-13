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
export declare class NovaError extends Error {
    cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
export declare class NovaSdk {
    private provider;
    private account?;
    contractId: string;
    pinataKey: string;
    pinataSecret: string;
    constructor(rpcUrl: string, contractId: string, pinataKey: string, pinataSecret: string);
    withSigner(privateKey: string, accountId: string): Promise<this>;
    getBalance(accountId: string): Promise<string>;
    isAuthorized(groupId: string, userId: string): Promise<boolean>;
    getGroupKey(groupId: string, userId: string): Promise<string>;
    getTransactionsForGroup(groupId: string, userId: string): Promise<Transaction[]>;
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
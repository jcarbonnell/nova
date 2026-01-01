import { AccountLike } from '@near-js/types';

interface ContractMetadata {
    spec?: string;
    name: string;
    symbol: string;
    icon?: string;
    baseUri?: string;
    reference?: string;
    referenceHash?: string;
}
interface NFTMetadata {
    title?: string;
    description?: string;
    media?: string;
    mediaHash?: string;
    copies?: number;
    issuedAt?: string;
    expiresAt?: string;
    startsAt?: string;
    updatedAt?: string;
    extra?: string;
    reference?: string;
    referenceHash?: string;
}
declare class NFTContract {
    readonly metadata: ContractMetadata;
    readonly accountId: string;
    constructor(accountId: string, metadata: ContractMetadata);
    transfer({ from, receiverId, tokenId }: {
        from: AccountLike;
        receiverId: string;
        tokenId: string;
    }): Promise<any>;
}
declare class NonFungibleToken {
    readonly contractId: string;
    readonly tokenId: string;
    readonly ownerId: string;
    readonly metadata: NFTMetadata;
    constructor(contractId: string, tokenId: string, ownerId: string, metadata: NFTMetadata);
}

export { NFTContract, NonFungibleToken };

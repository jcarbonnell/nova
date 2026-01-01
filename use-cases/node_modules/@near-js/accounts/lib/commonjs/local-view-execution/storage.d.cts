import { BlockReference, BlockHash } from '@near-js/types';
import { ContractState } from './types.cjs';

interface StorageData {
    blockHeight: number;
    blockTimestamp: number;
    contractCode: string;
    contractState: ContractState;
}
interface StorageOptions {
    max: number;
}
declare class Storage {
    private readonly cache;
    private static MAX_ELEMENTS;
    private blockHeights;
    constructor(options?: StorageOptions);
    load(blockRef: BlockReference): StorageData | undefined;
    save(blockHash: BlockHash, { blockHeight, blockTimestamp, contractCode, contractState }: StorageData): void;
}

export { Storage, type StorageData, type StorageOptions };

/**
 * NEAR RPC API request types and responses
 * @module
 */
interface SyncInfo {
    latest_block_hash: string;
    latest_block_height: number;
    latest_block_time: string;
    latest_state_root: string;
    syncing: boolean;
}
interface ValidatorInfo {
    account_id: string;
    is_slashed: boolean;
}
interface Version {
    version: string;
    build: string;
    rustc_version: string;
}
interface NodeStatusResult {
    chain_id: string;
    rpc_addr: string;
    sync_info: SyncInfo;
    validators: ValidatorInfo[];
    version: Version;
    protocol_version: number;
    latest_protocol_version: number;
    uptime_sec: number;
    genesis_hash: string;
}
type BlockHash = string;
type BlockHeight = number;
type BlockId = BlockHash | BlockHeight;
type Finality = 'optimistic' | 'near-final' | 'final';
type TxExecutionStatus = 'NONE' | 'INCLUDED' | 'INCLUDED_FINAL' | 'EXECUTED' | 'FINAL' | 'EXECUTED_OPTIMISTIC';
type FinalityReference = {
    finality: Finality;
};
type BlockReference = {
    blockId: BlockId;
} | FinalityReference | {
    /** @deprecated */
    sync_checkpoint: 'genesis' | 'earliest_available';
};
interface TotalWeight {
    num: number;
}
interface BlockHeader {
    height: number;
    epoch_id: string;
    next_epoch_id: string;
    hash: string;
    prev_hash: string;
    prev_state_root: string;
    chunk_receipts_root: string;
    chunk_headers_root: string;
    chunk_tx_root: string;
    outcome_root: string;
    chunks_included: number;
    challenges_root: string;
    timestamp: number;
    timestamp_nanosec: string;
    random_value: string;
    validator_proposals: any[];
    chunk_mask: boolean[];
    gas_price: string;
    rent_paid: string;
    validator_reward: string;
    total_supply: string;
    challenges_result: any[];
    last_final_block: string;
    last_ds_final_block: string;
    next_bp_hash: string;
    block_merkle_root: string;
    approvals: string[];
    signature: string;
    latest_protocol_version: number;
}
type ChunkHash = string;
type ShardId = number;
type BlockShardId = [BlockId, ShardId];
type ChunkId = ChunkHash | BlockShardId;
interface ChunkHeader {
    balance_burnt: string;
    chunk_hash: ChunkHash;
    encoded_length: number;
    encoded_merkle_root: string;
    gas_limit: number;
    gas_used: number;
    height_created: number;
    height_included: number;
    outcome_root: string;
    outgoing_receipts_root: string;
    prev_block_hash: string;
    prev_state_root: string;
    rent_paid: string;
    shard_id: number;
    signature: string;
    tx_root: string;
    validator_proposals: any[];
    validator_reward: string;
}
interface ChunkResult {
    author: string;
    header: ChunkHeader;
    receipts: any[];
    transactions: Transaction[];
}
interface Chunk {
    chunk_hash: string;
    prev_block_hash: string;
    outcome_root: string;
    prev_state_root: string;
    encoded_merkle_root: string;
    encoded_length: number;
    height_created: number;
    height_included: number;
    shard_id: number;
    gas_used: number;
    gas_limit: number;
    rent_paid: string;
    validator_reward: string;
    balance_burnt: string;
    outgoing_receipts_root: string;
    tx_root: string;
    validator_proposals: any[];
    signature: string;
}
interface Transaction {
    actions: Array<any>;
    hash: string;
    nonce: bigint;
    public_key: string;
    receiver_id: string;
    signature: string;
    signer_id: string;
}
interface BlockResult {
    author: string;
    header: BlockHeader;
    chunks: Chunk[];
}
interface BlockChange {
    type: string;
    account_id: string;
}
interface BlockChangeResult {
    block_hash: string;
    changes: BlockChange[];
}
interface ChangeResult {
    block_hash: string;
    changes: any[];
}
interface NearProtocolConfig {
    runtime_config: NearProtocolRuntimeConfig;
    minimum_stake_ratio: [number, number];
    protocol_version: number;
}
interface NearProtocolRuntimeConfig {
    storage_amount_per_byte: string;
}
interface MerkleNode {
    hash: string;
    direction: string;
}
type MerklePath = MerkleNode[];
interface BlockHeaderInnerLiteView {
    height: number;
    epoch_id: string;
    next_epoch_id: string;
    prev_state_root: string;
    outcome_root: string;
    timestamp: number;
    timestamp_nanosec: string;
    next_bp_hash: string;
    block_merkle_root: string;
}
interface GasPrice {
    gas_price: string;
}
interface AccessKeyWithPublicKey {
    account_id: string;
    public_key: string;
}

export type { AccessKeyWithPublicKey, BlockChange, BlockChangeResult, BlockHash, BlockHeader, BlockHeaderInnerLiteView, BlockHeight, BlockId, BlockReference, BlockResult, BlockShardId, ChangeResult, Chunk, ChunkHash, ChunkHeader, ChunkId, ChunkResult, Finality, FinalityReference, GasPrice, MerkleNode, MerklePath, NearProtocolConfig, NearProtocolRuntimeConfig, NodeStatusResult, ShardId, SyncInfo, TotalWeight, Transaction, TxExecutionStatus };

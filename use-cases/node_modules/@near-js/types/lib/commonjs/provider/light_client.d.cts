import { BlockHeaderInnerLiteView, MerklePath } from './protocol.cjs';
import { ExecutionOutcomeWithIdView } from './response.cjs';
import { ValidatorStakeView } from './validator.cjs';

/**
 * NEAR RPC API request types and responses
 * @module
 */

interface LightClientBlockLiteView {
    prev_block_hash: string;
    inner_rest_hash: string;
    inner_lite: BlockHeaderInnerLiteView;
}
interface LightClientProof {
    outcome_proof: ExecutionOutcomeWithIdView;
    outcome_root_proof: MerklePath;
    block_header_lite: LightClientBlockLiteView;
    block_proof: MerklePath;
}
declare enum IdType {
    Transaction = "transaction",
    Receipt = "receipt"
}
interface LightClientProofRequest {
    type: IdType;
    light_client_head: string;
    transaction_hash?: string;
    sender_id?: string;
    receipt_id?: string;
    receiver_id?: string;
}
interface NextLightClientBlockResponse {
    prev_block_hash: string;
    next_block_inner_hash: string;
    inner_lite: BlockHeaderInnerLiteView;
    inner_rest_hash: string;
    next_bps?: ValidatorStakeView[];
    approvals_after_next: (string | null)[];
}
interface NextLightClientBlockRequest {
    last_block_hash: string;
}

export { IdType, type LightClientBlockLiteView, type LightClientProof, type LightClientProofRequest, type NextLightClientBlockRequest, type NextLightClientBlockResponse };

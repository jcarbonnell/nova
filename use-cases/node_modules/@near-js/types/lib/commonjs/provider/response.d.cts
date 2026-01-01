import { MerklePath, BlockHeight, BlockHash, TxExecutionStatus } from './protocol.cjs';

/**
 * NEAR RPC API request types and responses
 * @module
 */

type SerializedReturnValue = string | number | boolean | object;
declare enum ExecutionStatusBasic {
    Unknown = "Unknown",
    Pending = "Pending",
    Failure = "Failure"
}
interface ExecutionStatus {
    SuccessValue?: string;
    SuccessReceiptId?: string;
    Failure?: ExecutionError;
}
declare enum FinalExecutionStatusBasic {
    NotStarted = "NotStarted",
    Started = "Started",
    Failure = "Failure"
}
interface ExecutionError {
    error_message: string;
    error_type: string;
}
interface FinalExecutionStatus {
    SuccessValue?: string;
    Failure?: ExecutionError;
}
interface ExecutionOutcomeWithId {
    id: string;
    outcome: ExecutionOutcome;
}
interface ExecutionOutcome {
    logs: string[];
    receipt_ids: string[];
    gas_burnt: number;
    tokens_burnt: string;
    executor_id: string;
    status: ExecutionStatus | ExecutionStatusBasic;
}
type ReceiptAction = {
    Transfer: {
        deposit: string;
    };
};
interface ExecutionOutcomeReceiptDetail {
    predecessor_id: string;
    receipt: {
        Action: ExecutionOutcomeReceiptAction;
    };
    receipt_id: string;
    receiver_id: string;
}
interface ExecutionOutcomeReceiptAction {
    actions: ReceiptAction[];
    gas_price: string;
    input_data_ids: string[];
    output_data_receivers: string[];
    signer_id: string;
    signer_public_key: string;
}
interface ExecutionOutcomeWithIdView {
    proof: MerklePath;
    block_hash: string;
    id: string;
    outcome: ExecutionOutcome;
}
interface FinalExecutionOutcome {
    final_execution_status: TxExecutionStatus;
    status: FinalExecutionStatus | FinalExecutionStatusBasic;
    transaction: any;
    transaction_outcome: ExecutionOutcomeWithId;
    receipts_outcome: ExecutionOutcomeWithId[];
    receipts?: ExecutionOutcomeReceiptDetail[];
}
interface QueryResponseKind {
    block_height: BlockHeight;
    block_hash: BlockHash;
}
interface AccountViewRaw extends QueryResponseKind {
    amount: string;
    locked: string;
    code_hash: string;
    storage_usage: number;
    storage_paid_at: BlockHeight;
}
interface AccountView extends QueryResponseKind {
    amount: bigint;
    locked: bigint;
    code_hash: string;
    storage_usage: number;
    storage_paid_at: BlockHeight;
}
interface AccountBalanceInfo {
    total: bigint;
    usedOnStorage: bigint;
    locked: bigint;
    available: bigint;
}
interface StateItem {
    key: string;
    value: string;
    proof: string[];
}
interface ViewStateResult extends QueryResponseKind {
    values: StateItem[];
    proof: string[];
}
interface CodeResult extends QueryResponseKind {
    result: number[];
    logs: string[];
}
interface CallContractViewFunctionResultRaw extends QueryResponseKind {
    result: number[];
    logs: string[];
}
interface CallContractViewFunctionResult extends QueryResponseKind {
    result?: string | number | any;
    logs: string[];
}
interface StateItemView {
    key: string;
    value: string;
    proof: string[];
}
interface ContractStateView extends QueryResponseKind {
    values: StateItemView[];
}
interface ContractCodeViewRaw extends QueryResponseKind {
    code_base64: string;
    hash: string;
}
interface ContractCodeView extends QueryResponseKind {
    code: Uint8Array;
    hash: string;
}
interface FunctionCallPermissionView {
    FunctionCall: {
        allowance: string;
        receiver_id: string;
        method_names: string[];
    };
}
interface AccessKeyViewRaw extends QueryResponseKind {
    nonce: number;
    permission: 'FullAccess' | FunctionCallPermissionView;
}
interface AccessKeyView extends QueryResponseKind {
    nonce: bigint;
    permission: 'FullAccess' | FunctionCallPermissionView;
}
interface AccessKeyList extends QueryResponseKind {
    keys: AccessKeyInfoView[];
}
interface AccessKeyInfoView {
    public_key: string;
    access_key: AccessKeyView;
}
interface AccessKeyInfoView {
    public_key: string;
    access_key: AccessKeyView;
}

export { type AccessKeyInfoView, type AccessKeyList, type AccessKeyView, type AccessKeyViewRaw, type AccountBalanceInfo, type AccountView, type AccountViewRaw, type CallContractViewFunctionResult, type CallContractViewFunctionResultRaw, type CodeResult, type ContractCodeView, type ContractCodeViewRaw, type ContractStateView, type ExecutionError, type ExecutionOutcome, type ExecutionOutcomeReceiptAction, type ExecutionOutcomeReceiptDetail, type ExecutionOutcomeWithId, type ExecutionOutcomeWithIdView, type ExecutionStatus, ExecutionStatusBasic, type FinalExecutionOutcome, type FinalExecutionStatus, FinalExecutionStatusBasic, type FunctionCallPermissionView, type QueryResponseKind, type ReceiptAction, type SerializedReturnValue, type ViewStateResult };

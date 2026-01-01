import { BlockReference } from './protocol.cjs';

/**
 * NEAR RPC API request types and responses
 * @module
 */

interface ViewAccountRequest {
    request_type: 'view_account';
    account_id: string;
}
interface ViewCodeRequest {
    request_type: 'view_code';
    account_id: string;
}
interface ViewStateRequest {
    request_type: 'view_state';
    account_id: string;
    prefix_base64: string;
}
interface ViewAccessKeyRequest {
    request_type: 'view_access_key';
    account_id: string;
    public_key: string;
}
interface ViewAccessKeyListRequest {
    request_type: 'view_access_key_list';
    account_id: string;
}
interface CallFunctionRequest {
    request_type: 'call_function';
    account_id: string;
    method_name: string;
    args_base64: string;
}
type RpcQueryRequest = (ViewAccountRequest | ViewCodeRequest | ViewStateRequest | ViewAccountRequest | ViewAccessKeyRequest | ViewAccessKeyListRequest | CallFunctionRequest) & BlockReference;

export type { CallFunctionRequest, RpcQueryRequest, ViewAccessKeyListRequest, ViewAccessKeyRequest, ViewAccountRequest, ViewCodeRequest, ViewStateRequest };

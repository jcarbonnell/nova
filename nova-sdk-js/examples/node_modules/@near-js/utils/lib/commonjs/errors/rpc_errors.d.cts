import { TypedError } from '@near-js/types';

declare class ServerError extends TypedError {
}
declare class ServerTransactionError extends ServerError {
    transaction_outcome: any;
}
declare function parseRpcError(errorObj: Record<string, any>): ServerError;
declare function parseResultError(result: any): ServerTransactionError;
declare function formatError(errorClassName: string, errorData: any): string;
declare function getErrorTypeFromErrorMessage(errorMessage: any, errorType: any): any;

export { ServerError, formatError, getErrorTypeFromErrorMessage, parseResultError, parseRpcError };

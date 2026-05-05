declare class PositionalArgsError extends Error {
    constructor();
}
declare class ArgumentTypeError extends Error {
    constructor(argName: string, argType: string, argValue: any);
}
declare class TypedError extends Error {
    type: string;
    context?: ErrorContext;
    constructor(message?: string, type?: string, context?: ErrorContext);
}
declare class ErrorContext {
    transactionHash?: string;
    constructor(transactionHash?: string);
}

export { ArgumentTypeError, ErrorContext, PositionalArgsError, TypedError };

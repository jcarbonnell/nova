import { ValidationError } from 'is-my-json-valid';

declare class UnsupportedSerializationError extends Error {
    constructor(methodName: string, serializationType: string);
}
declare class UnknownArgumentError extends Error {
    constructor(actualArgName: string, expectedArgNames: string[]);
}
declare class ArgumentSchemaError extends Error {
    constructor(argName: string, errors: ValidationError[]);
}
declare class ConflictingOptions extends Error {
    constructor();
}

export { ArgumentSchemaError, ConflictingOptions, UnknownArgumentError, UnsupportedSerializationError };

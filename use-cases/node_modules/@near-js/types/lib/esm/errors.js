class PositionalArgsError extends Error {
  constructor() {
    super("Contract method calls expect named arguments wrapped in object, e.g. { argName1: argValue1, argName2: argValue2 }");
  }
}
class ArgumentTypeError extends Error {
  constructor(argName, argType, argValue) {
    super(`Expected ${argType} for '${argName}' argument, but got '${JSON.stringify(argValue)}'`);
  }
}
class TypedError extends Error {
  type;
  context;
  constructor(message, type, context) {
    super(message);
    this.type = type || "UntypedError";
    this.context = context;
  }
}
class ErrorContext {
  transactionHash;
  constructor(transactionHash) {
    this.transactionHash = transactionHash;
  }
}
export {
  ArgumentTypeError,
  ErrorContext,
  PositionalArgsError,
  TypedError
};

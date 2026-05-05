"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var errors_exports = {};
__export(errors_exports, {
  ArgumentTypeError: () => ArgumentTypeError,
  ErrorContext: () => ErrorContext,
  PositionalArgsError: () => PositionalArgsError,
  TypedError: () => TypedError
});
module.exports = __toCommonJS(errors_exports);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ArgumentTypeError,
  ErrorContext,
  PositionalArgsError,
  TypedError
});

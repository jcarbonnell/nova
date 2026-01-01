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
  ArgumentSchemaError: () => ArgumentSchemaError,
  ConflictingOptions: () => ConflictingOptions,
  UnknownArgumentError: () => UnknownArgumentError,
  UnsupportedSerializationError: () => UnsupportedSerializationError
});
module.exports = __toCommonJS(errors_exports);
class UnsupportedSerializationError extends Error {
  constructor(methodName, serializationType) {
    super(`Contract method '${methodName}' is using an unsupported serialization type ${serializationType}`);
  }
}
class UnknownArgumentError extends Error {
  constructor(actualArgName, expectedArgNames) {
    super(`Unrecognized argument '${actualArgName}', expected '${JSON.stringify(expectedArgNames)}'`);
  }
}
class ArgumentSchemaError extends Error {
  constructor(argName, errors) {
    super(`Argument '${argName}' does not conform to the specified ABI schema: '${JSON.stringify(errors)}'`);
  }
}
class ConflictingOptions extends Error {
  constructor() {
    super("Conflicting contract method options have been passed. You can either specify ABI or a list of view/call methods.");
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ArgumentSchemaError,
  ConflictingOptions,
  UnknownArgumentError,
  UnsupportedSerializationError
});

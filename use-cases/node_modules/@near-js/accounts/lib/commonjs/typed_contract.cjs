"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var typed_contract_exports = {};
__export(typed_contract_exports, {
  TypedContract: () => TypedContract
});
module.exports = __toCommonJS(typed_contract_exports);
var import_errors = require('./errors.cjs');
var import_is_my_json_valid = __toESM(require("is-my-json-valid"), 1);
class Contract {
  abi;
  contractId;
  view;
  call;
  constructor({
    abi,
    provider,
    contractId
  }) {
    this.contractId = contractId;
    this.abi = abi;
    let hasViewFunction = false;
    let hasCallFunction = false;
    const abiFunctions = abi?.body.functions || [];
    for (const func of abiFunctions) {
      if (func.kind === "view") {
        hasViewFunction = true;
      } else if (func.kind === "call") {
        hasCallFunction = true;
      }
      if (hasViewFunction && hasCallFunction) break;
    }
    if (hasViewFunction || !abi) {
      this.view = new Proxy(
        {},
        {
          get: (_, functionName) => {
            const abiFunction = (abi?.body.functions || []).find(
              ({ name }) => name === functionName
            );
            return async (params = {}) => {
              const args = params.args ?? {};
              if (abiFunction && abi) {
                validateArguments(args, abiFunction, abi);
              }
              return provider.callFunction(
                contractId,
                functionName,
                args,
                params.blockQuery
              );
            };
          }
        }
      );
    }
    if (hasCallFunction || !abi) {
      this.call = new Proxy(
        {},
        {
          get: (_, functionName) => {
            const abiFunction = (abi?.body.functions || []).find(
              ({ name }) => name === functionName
            );
            return async (params) => {
              const args = params.args ?? {};
              if (abiFunction && abi) {
                validateArguments(args, abiFunction, abi);
              }
              return params.account.callFunction({
                contractId,
                methodName: functionName,
                args,
                deposit: params.deposit,
                gas: params.gas,
                waitUntil: params.waitUntil
              });
            };
          }
        }
      );
    }
    if (!abi) {
      delete this.abi;
    }
  }
}
const TypedContract = Contract;
function validateArguments(args, abiFunction, abiRoot) {
  if (typeof args !== "object" || typeof abiFunction.params !== "object")
    return;
  if (abiFunction.params.serialization_type === "json") {
    const params = abiFunction.params.args;
    for (const p of params) {
      const arg = args[p.name];
      const typeSchema = p.type_schema;
      typeSchema.definitions = abiRoot.body.root_schema.definitions;
      const validate = (0, import_is_my_json_valid.default)(typeSchema);
      const valid = validate(arg);
      if (!valid) {
        throw new import_errors.ArgumentSchemaError(p.name, validate.errors);
      }
    }
    for (const argName of Object.keys(args)) {
      const param = params.find((p) => p.name === argName);
      if (!param) {
        throw new import_errors.UnknownArgumentError(
          argName,
          params.map((p) => p.name)
        );
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TypedContract
});

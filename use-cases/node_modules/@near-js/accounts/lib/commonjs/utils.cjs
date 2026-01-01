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
var utils_exports = {};
__export(utils_exports, {
  validateArgs: () => validateArgs,
  viewFunction: () => viewFunction,
  viewState: () => viewState
});
module.exports = __toCommonJS(utils_exports);
var import_types = require("@near-js/types");
var import_utils = require("@near-js/utils");
var import_depd = __toESM(require("depd"), 1);
function parseJsonFromRawResponse(response) {
  return JSON.parse(Buffer.from(response).toString());
}
function bytesJsonStringify(input) {
  return Buffer.from(JSON.stringify(input));
}
function validateArgs(args) {
  const isUint8Array = args.byteLength !== void 0 && args.byteLength === args.length;
  if (isUint8Array) {
    return;
  }
  if (Array.isArray(args) || typeof args !== "object") {
    throw new import_types.PositionalArgsError();
  }
}
async function viewState(connection, accountId, prefix, blockQuery = { finality: "optimistic" }) {
  const deprecate = (0, import_depd.default)("viewState()");
  deprecate("It will be removed in the next major release");
  const { values } = await connection.provider.query({
    request_type: "view_state",
    ...blockQuery,
    account_id: accountId,
    prefix_base64: Buffer.from(prefix).toString("base64")
  });
  return values.map(({ key, value }) => ({
    key: Buffer.from(key, "base64"),
    value: Buffer.from(value, "base64")
  }));
}
async function viewFunction(connection, {
  contractId,
  methodName,
  args = {},
  parse = parseJsonFromRawResponse,
  stringify = bytesJsonStringify,
  blockQuery = { finality: "optimistic" }
}) {
  const deprecate = (0, import_depd.default)("viewFunction()");
  deprecate("It will be removed in the next major release");
  validateArgs(args);
  const encodedArgs = stringify(args);
  const result = await connection.provider.query({
    request_type: "call_function",
    ...blockQuery,
    account_id: contractId,
    method_name: methodName,
    args_base64: encodedArgs.toString("base64")
  });
  if (result.logs) {
    (0, import_utils.printTxOutcomeLogs)({ contractId, logs: result.logs });
  }
  return result.result && result.result.length > 0 && parse(Buffer.from(result.result));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  validateArgs,
  viewFunction,
  viewState
});

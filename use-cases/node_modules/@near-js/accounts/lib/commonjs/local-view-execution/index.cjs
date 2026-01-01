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
var local_view_execution_exports = {};
__export(local_view_execution_exports, {
  LocalViewExecution: () => LocalViewExecution
});
module.exports = __toCommonJS(local_view_execution_exports);
var import_utils = require("@near-js/utils");
var import_storage = require('./storage.cjs');
var import_runtime = require('./runtime.cjs');
var import_utils2 = require('../utils.cjs');
var import_depd = __toESM(require("depd"), 1);
class LocalViewExecution {
  connection;
  storage;
  constructor(connection) {
    this.connection = connection.getConnection();
    this.storage = new import_storage.Storage();
    const deprecate = (0, import_depd.default)("LocalViewExecution");
    deprecate("It will be removed in the next major release");
  }
  async fetchContractCode(contractId, blockQuery) {
    const result = await this.connection.provider.query({
      request_type: "view_code",
      account_id: contractId,
      ...blockQuery
    });
    return result.code_base64;
  }
  async fetchContractState(contractId, blockQuery) {
    return (0, import_utils2.viewState)(this.connection, contractId, "", blockQuery);
  }
  async fetch(contractId, blockQuery) {
    const block = await this.connection.provider.block(blockQuery);
    const blockHash = block.header.hash;
    const blockHeight = block.header.height;
    const blockTimestamp = block.header.timestamp;
    const contractCode = await this.fetchContractCode(contractId, blockQuery);
    const contractState = await this.fetchContractState(contractId, blockQuery);
    return {
      blockHash,
      blockHeight,
      blockTimestamp,
      contractCode,
      contractState
    };
  }
  async loadOrFetch(contractId, blockQuery) {
    const stored = this.storage.load(blockQuery);
    if (stored) {
      return stored;
    }
    const { blockHash, ...fetched } = await this.fetch(contractId, blockQuery);
    this.storage.save(blockHash, fetched);
    return fetched;
  }
  /**
   * Calls a view function on a contract, fetching the contract code and state if needed.
   * @param options Options for calling the view function.
   * @param options.contractId The contract account ID.
   * @param options.methodName The name of the view function to call.
   * @param options.args The arguments to pass to the view function.
   * @param options.blockQuery The block query options.
   * @returns {Promise<any>} - A promise that resolves to the result of the view function.
   */
  async viewFunction({ contractId, methodName, args = {}, blockQuery = { finality: "optimistic" } }) {
    const methodArgs = JSON.stringify(args);
    const { contractCode, contractState, blockHeight, blockTimestamp } = await this.loadOrFetch(
      contractId,
      blockQuery
    );
    const runtime = new import_runtime.Runtime({ contractId, contractCode, contractState, blockHeight, blockTimestamp, methodArgs });
    const { result, logs } = await runtime.execute(methodName);
    if (logs) {
      (0, import_utils.printTxOutcomeLogs)({ contractId, logs });
    }
    return JSON.parse(Buffer.from(result).toString());
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LocalViewExecution
});

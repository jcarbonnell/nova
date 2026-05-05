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
var index_exports = {};
__export(index_exports, {
  FailoverRpcProvider: () => import_failover_rpc_provider.FailoverRpcProvider,
  JsonRpcProvider: () => import_json_rpc_provider.JsonRpcProvider,
  exponentialBackoff: () => import_exponential_backoff.exponentialBackoff
});
module.exports = __toCommonJS(index_exports);
var import_exponential_backoff = require('./exponential-backoff.cjs');
var import_json_rpc_provider = require('./json-rpc-provider.cjs');
var import_failover_rpc_provider = require('./failover-rpc-provider.cjs');
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FailoverRpcProvider,
  JsonRpcProvider,
  exponentialBackoff
});

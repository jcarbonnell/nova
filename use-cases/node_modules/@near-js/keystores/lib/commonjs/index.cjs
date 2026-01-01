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
  InMemoryKeyStore: () => import_in_memory_key_store.InMemoryKeyStore,
  KeyStore: () => import_keystore.KeyStore,
  MergeKeyStore: () => import_merge_key_store.MergeKeyStore,
  MultiContractKeyStore: () => import_multi_contract_keystore.MultiContractKeyStore
});
module.exports = __toCommonJS(index_exports);
var import_in_memory_key_store = require('./in_memory_key_store.cjs');
var import_keystore = require('./keystore.cjs');
var import_merge_key_store = require('./merge_key_store.cjs');
var import_multi_contract_keystore = require('./multi_contract_keystore.cjs');
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  InMemoryKeyStore,
  KeyStore,
  MergeKeyStore,
  MultiContractKeyStore
});

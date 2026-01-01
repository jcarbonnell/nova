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
var create_transaction_exports = {};
__export(create_transaction_exports, {
  createTransaction: () => createTransaction
});
module.exports = __toCommonJS(create_transaction_exports);
var import_schema = require('./schema.cjs');
function createTransaction(signerId, publicKey, receiverId, nonce, actions, blockHash) {
  const txNonce = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  return new import_schema.Transaction({
    signerId,
    publicKey,
    nonce: txNonce,
    receiverId,
    actions,
    blockHash
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createTransaction
});

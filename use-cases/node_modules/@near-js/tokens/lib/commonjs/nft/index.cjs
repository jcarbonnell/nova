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
var nft_exports = {};
__export(nft_exports, {
  NFTContract: () => NFTContract,
  NonFungibleToken: () => NonFungibleToken
});
module.exports = __toCommonJS(nft_exports);
class NFTContract {
  metadata;
  accountId;
  constructor(accountId, metadata) {
    metadata.spec = metadata.spec || "nft-1.0.0";
    this.metadata = metadata;
    this.accountId = accountId;
  }
  transfer({
    from,
    receiverId,
    tokenId
  }) {
    return from.callFunction({
      contractId: this.accountId,
      methodName: "nft_transfer",
      args: {
        receiver_id: receiverId,
        token_id: tokenId
      },
      deposit: 1,
      gas: 3e13
    });
  }
}
class NonFungibleToken {
  contractId;
  tokenId;
  ownerId;
  metadata;
  constructor(contractId, tokenId, ownerId, metadata) {
    this.contractId = contractId;
    this.tokenId = tokenId;
    this.ownerId = ownerId;
    this.metadata = metadata;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NFTContract,
  NonFungibleToken
});

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
var storage_exports = {};
__export(storage_exports, {
  Storage: () => Storage
});
module.exports = __toCommonJS(storage_exports);
var LRU = __toESM(require("lru_map"), 1);
class Storage {
  cache;
  static MAX_ELEMENTS = 100;
  // map block hash to block height
  blockHeights;
  constructor(options = { max: Storage.MAX_ELEMENTS }) {
    this.cache = new LRU.LRUMap(options.max);
    this.blockHeights = /* @__PURE__ */ new Map();
  }
  load(blockRef) {
    const noBlockId = !("blockId" in blockRef);
    if (noBlockId) return void 0;
    let blockId = blockRef.blockId;
    if (blockId.toString().length == 44) {
      blockId = this.blockHeights.get(blockId.toString());
    }
    return this.cache.get(blockId);
  }
  save(blockHash, { blockHeight, blockTimestamp, contractCode, contractState }) {
    this.blockHeights.set(blockHash, blockHeight);
    this.cache.set(blockHeight, { blockHeight, blockTimestamp, contractCode, contractState });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Storage
});

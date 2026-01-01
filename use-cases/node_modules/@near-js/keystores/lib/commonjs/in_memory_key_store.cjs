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
var in_memory_key_store_exports = {};
__export(in_memory_key_store_exports, {
  InMemoryKeyStore: () => InMemoryKeyStore
});
module.exports = __toCommonJS(in_memory_key_store_exports);
var import_crypto = require("@near-js/crypto");
var import_keystore = require('./keystore.cjs');
class InMemoryKeyStore extends import_keystore.KeyStore {
  /** @hidden */
  keys;
  constructor() {
    super();
    this.keys = {};
  }
  /**
   * Stores a {@link KeyPair} in in-memory storage item
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   * @param keyPair The key pair to store in local storage
   */
  async setKey(networkId, accountId, keyPair) {
    this.keys[`${accountId}:${networkId}`] = keyPair.toString();
  }
  /**
   * Gets a {@link KeyPair} from in-memory storage
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   * @returns {Promise<KeyPair>}
   */
  async getKey(networkId, accountId) {
    const value = this.keys[`${accountId}:${networkId}`];
    if (!value) {
      return null;
    }
    return import_crypto.KeyPair.fromString(value);
  }
  /**
   * Removes a {@link KeyPair} from in-memory storage
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   */
  async removeKey(networkId, accountId) {
    delete this.keys[`${accountId}:${networkId}`];
  }
  /**
   * Removes all {@link KeyPair} from in-memory storage
   */
  async clear() {
    this.keys = {};
  }
  /**
   * Get the network(s) from in-memory storage
   * @returns {Promise<string[]>}
   */
  async getNetworks() {
    const result = /* @__PURE__ */ new Set();
    Object.keys(this.keys).forEach((key) => {
      const parts = key.split(":");
      result.add(parts[1]);
    });
    return Array.from(result.values());
  }
  /**
   * Gets the account(s) from in-memory storage
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   */
  async getAccounts(networkId) {
    const result = new Array();
    Object.keys(this.keys).forEach((key) => {
      const parts = key.split(":");
      if (parts[parts.length - 1] === networkId) {
        result.push(parts.slice(0, parts.length - 1).join(":"));
      }
    });
    return result;
  }
  /** @hidden */
  toString() {
    return "InMemoryKeyStore";
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  InMemoryKeyStore
});

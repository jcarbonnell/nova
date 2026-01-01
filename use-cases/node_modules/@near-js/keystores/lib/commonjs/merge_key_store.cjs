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
var merge_key_store_exports = {};
__export(merge_key_store_exports, {
  MergeKeyStore: () => MergeKeyStore
});
module.exports = __toCommonJS(merge_key_store_exports);
var import_keystore = require('./keystore.cjs');
class MergeKeyStore extends import_keystore.KeyStore {
  options;
  keyStores;
  /**
   * @param keyStores read calls are attempted from start to end of array
   * @param options KeyStore options
   * @param options.writeKeyStoreIndex the keystore index that will receive all write calls
   */
  constructor(keyStores, options = { writeKeyStoreIndex: 0 }) {
    super();
    this.options = options;
    this.keyStores = keyStores;
  }
  /**
   * Store a {@link KeyPair} to the first index of a key store array
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   * @param keyPair The key pair to store in local storage
   */
  async setKey(networkId, accountId, keyPair) {
    await this.keyStores[this.options.writeKeyStoreIndex].setKey(networkId, accountId, keyPair);
  }
  /**
   * Gets a {@link KeyPair} from the array of key stores
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   * @returns {Promise<KeyPair>}
   */
  async getKey(networkId, accountId) {
    for (const keyStore of this.keyStores) {
      const keyPair = await keyStore.getKey(networkId, accountId);
      if (keyPair) {
        return keyPair;
      }
    }
    return null;
  }
  /**
   * Removes a {@link KeyPair} from the array of key stores
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   * @param accountId The NEAR account tied to the key pair
   */
  async removeKey(networkId, accountId) {
    for (const keyStore of this.keyStores) {
      await keyStore.removeKey(networkId, accountId);
    }
  }
  /**
   * Removes all items from each key store
   */
  async clear() {
    for (const keyStore of this.keyStores) {
      await keyStore.clear();
    }
  }
  /**
   * Get the network(s) from the array of key stores
   * @returns {Promise<string[]>}
   */
  async getNetworks() {
    const result = /* @__PURE__ */ new Set();
    for (const keyStore of this.keyStores) {
      for (const network of await keyStore.getNetworks()) {
        result.add(network);
      }
    }
    return Array.from(result);
  }
  /**
   * Gets the account(s) from the array of key stores
   * @param networkId The targeted network. (ex. default, betanet, etc…)
   */
  async getAccounts(networkId) {
    const result = /* @__PURE__ */ new Set();
    for (const keyStore of this.keyStores) {
      for (const account of await keyStore.getAccounts(networkId)) {
        result.add(account);
      }
    }
    return Array.from(result);
  }
  /** @hidden */
  toString() {
    return `MergeKeyStore(${this.keyStores.join(", ")})`;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MergeKeyStore
});

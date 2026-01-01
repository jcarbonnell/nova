import { KeyPair } from "@near-js/crypto";
import { KeyStore } from "./keystore.js";
class InMemoryKeyStore extends KeyStore {
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
    return KeyPair.fromString(value);
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
export {
  InMemoryKeyStore
};

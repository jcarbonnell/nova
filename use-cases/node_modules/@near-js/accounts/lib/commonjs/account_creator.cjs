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
var account_creator_exports = {};
__export(account_creator_exports, {
  AccountCreator: () => AccountCreator,
  LocalAccountCreator: () => LocalAccountCreator,
  UrlAccountCreator: () => UrlAccountCreator
});
module.exports = __toCommonJS(account_creator_exports);
var import_depd = __toESM(require("depd"), 1);
class AccountCreator {
  constructor() {
    const deprecate = (0, import_depd.default)("AccountCreator");
    deprecate(`${this.constructor.name} is deprecated and will be removed in the next major release`);
  }
}
class LocalAccountCreator extends AccountCreator {
  masterAccount;
  initialBalance;
  constructor(masterAccount, initialBalance) {
    super();
    this.masterAccount = masterAccount;
    this.initialBalance = initialBalance;
  }
  /**
   * Creates an account using a masterAccount, meaning the new account is created from an existing account
   * @param newAccountId The name of the NEAR account to be created
   * @param publicKey The public key from the masterAccount used to create this account
   * @returns {Promise<void>}
   */
  async createAccount(newAccountId, publicKey) {
    await this.masterAccount.createAccount(newAccountId, publicKey, this.initialBalance);
  }
}
class UrlAccountCreator extends AccountCreator {
  connection;
  helperUrl;
  constructor(connection, helperUrl) {
    super();
    this.connection = connection;
    this.helperUrl = helperUrl;
  }
  /**
   * Creates an account using a helperUrl
   * This is [hosted here](https://helper.nearprotocol.com) or set up locally with the [near-contract-helper](https://github.com/nearprotocol/near-contract-helper) repository
   * @param newAccountId The name of the NEAR account to be created
   * @param publicKey The public key from the masterAccount used to create this account
   * @returns {Promise<void>}
   */
  async createAccount(newAccountId, publicKey) {
    await fetch(`${this.helperUrl}/account`, {
      body: JSON.stringify({ newAccountId, newAccountPublicKey: publicKey.toString() }),
      method: "POST"
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AccountCreator,
  LocalAccountCreator,
  UrlAccountCreator
});

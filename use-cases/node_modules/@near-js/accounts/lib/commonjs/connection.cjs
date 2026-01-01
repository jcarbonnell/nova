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
var connection_exports = {};
__export(connection_exports, {
  Connection: () => Connection
});
module.exports = __toCommonJS(connection_exports);
var import_signers = require("@near-js/signers");
var import_providers = require("@near-js/providers");
var import_depd = __toESM(require("depd"), 1);
function getProvider(config) {
  switch (config.type) {
    case void 0:
      return config;
    case "JsonRpcProvider":
      return new import_providers.JsonRpcProvider({ ...config.args });
    case "FailoverRpcProvider": {
      const providers = (config?.args || []).map(
        (arg) => new import_providers.JsonRpcProvider(arg)
      );
      return new import_providers.FailoverRpcProvider(providers);
    }
    default:
      throw new Error(`Unknown provider type ${config.type}`);
  }
}
function getSigner(config) {
  switch (config.type) {
    case void 0:
      return config;
    case "KeyPairSigner": {
      return new import_signers.KeyPairSigner(config.keyPair);
    }
    default:
      throw new Error(`Unknown signer type ${config.type}`);
  }
}
class Connection {
  networkId;
  provider;
  signer;
  constructor(networkId, provider, signer) {
    const deprecate = (0, import_depd.default)("new Connection(networkId, provider, signer)");
    deprecate("`Connection` is no longer used anywhere, please switch to constructing `Account` without it - use `new Account(accountId, provider, signer)`");
    this.networkId = networkId;
    this.provider = provider;
    this.signer = signer;
  }
  getConnection() {
    return this;
  }
  /**
   * @param config Contains connection info details
   */
  static fromConfig(config) {
    const provider = getProvider(config.provider);
    const signer = getSigner(config.signer);
    return new Connection(
      config.networkId,
      provider,
      signer
    );
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Connection
});

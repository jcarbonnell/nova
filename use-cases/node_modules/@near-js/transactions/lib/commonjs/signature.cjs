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
var signature_exports = {};
__export(signature_exports, {
  Signature: () => Signature
});
module.exports = __toCommonJS(signature_exports);
var import_crypto = require("@near-js/crypto");
var import_types = require("@near-js/types");
class ED25519Signature {
  keyType = import_crypto.KeyType.ED25519;
  data;
}
class SECP256K1Signature {
  keyType = import_crypto.KeyType.SECP256K1;
  data;
}
function resolveEnumKeyName(keyType) {
  switch (keyType) {
    case import_crypto.KeyType.ED25519: {
      return "ed25519Signature";
    }
    case import_crypto.KeyType.SECP256K1: {
      return "secp256k1Signature";
    }
    default: {
      throw Error(`unknown type ${keyType}`);
    }
  }
}
class Signature extends import_types.Enum {
  enum;
  ed25519Signature;
  secp256k1Signature;
  constructor(signature) {
    const keyName = resolveEnumKeyName(signature.keyType);
    super({ [keyName]: signature });
    this[keyName] = signature;
    this.enum = keyName;
  }
  get signature() {
    return this.ed25519Signature || this.secp256k1Signature;
  }
  get signatureType() {
    return this.signature.keyType;
  }
  get data() {
    return this.signature.data;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Signature
});

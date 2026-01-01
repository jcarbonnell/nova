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
var key_pair_signer_exports = {};
__export(key_pair_signer_exports, {
  KeyPairSigner: () => KeyPairSigner
});
module.exports = __toCommonJS(key_pair_signer_exports);
var import_crypto = require("@near-js/crypto");
var import_sha256 = require("@noble/hashes/sha256");
var import_signer = require('./signer.cjs');
var import_transactions = require("@near-js/transactions");
var import_borsh = require("borsh");
class KeyPairSigner extends import_signer.Signer {
  key;
  constructor(key) {
    super();
    this.key = key;
  }
  static fromSecretKey(encodedKey) {
    const key = import_crypto.KeyPair.fromString(encodedKey);
    return new KeyPairSigner(key);
  }
  async getPublicKey() {
    return this.key.getPublicKey();
  }
  async signNep413Message(message, accountId, recipient, nonce, callbackUrl) {
    if (nonce.length !== 32)
      throw new Error("Nonce must be exactly 32 bytes long");
    const pk = this.key.getPublicKey();
    const PREFIX = 2147484061;
    const serializedPrefix = (0, import_borsh.serialize)("u32", PREFIX);
    const params = {
      message,
      recipient,
      nonce,
      callbackUrl
    };
    const serializedParams = (0, import_borsh.serialize)(import_signer.Nep413MessageSchema, params);
    const serializedMessage = new Uint8Array(
      serializedPrefix.length + serializedParams.length
    );
    serializedMessage.set(serializedPrefix);
    serializedMessage.set(serializedParams, serializedPrefix.length);
    const hash = new Uint8Array((0, import_sha256.sha256)(serializedMessage));
    const { signature } = this.key.sign(hash);
    return {
      accountId,
      publicKey: pk,
      signature
    };
  }
  async signTransaction(transaction) {
    const pk = this.key.getPublicKey();
    if (transaction.publicKey.toString() !== pk.toString())
      throw new Error("The public key doesn't match the signer's key");
    const message = (0, import_transactions.encodeTransaction)(transaction);
    const hash = new Uint8Array((0, import_sha256.sha256)(message));
    const { signature } = this.key.sign(hash);
    const signedTx = new import_transactions.SignedTransaction({
      transaction,
      signature: new import_transactions.Signature({
        keyType: transaction.publicKey.ed25519Key ? import_crypto.KeyType.ED25519 : import_crypto.KeyType.SECP256K1,
        data: signature
      })
    });
    return [hash, signedTx];
  }
  async signDelegateAction(delegateAction) {
    const pk = this.key.getPublicKey();
    if (delegateAction.publicKey.toString() !== pk.toString())
      throw new Error("The public key doesn't match the signer's key");
    const message = (0, import_transactions.encodeDelegateAction)(delegateAction);
    const hash = new Uint8Array((0, import_sha256.sha256)(message));
    const { signature } = this.key.sign(hash);
    const signedDelegate = new import_transactions.SignedDelegate({
      delegateAction,
      signature: new import_transactions.Signature({
        keyType: pk.keyType,
        data: signature
      })
    });
    return [hash, signedDelegate];
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  KeyPairSigner
});

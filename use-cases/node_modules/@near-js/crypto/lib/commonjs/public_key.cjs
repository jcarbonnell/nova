"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }var _utils = require('@near-js/utils');
var _ed25519 = require('@noble/curves/ed25519');
var _secp256k1 = require('secp256k1'); var _secp256k12 = _interopRequireDefault(_secp256k1);
var _constantscjs = require('./constants.cjs');
function key_type_to_str(keyType) {
  switch (keyType) {
    case _constantscjs.KeyType.ED25519:
      return "ed25519";
    case _constantscjs.KeyType.SECP256K1:
      return "secp256k1";
    default:
      throw new Error(`Unknown key type ${keyType}`);
  }
}
function str_to_key_type(keyType) {
  switch (keyType.toLowerCase()) {
    case "ed25519":
      return _constantscjs.KeyType.ED25519;
    case "secp256k1":
      return _constantscjs.KeyType.SECP256K1;
    default:
      throw new Error(`Unknown key type ${keyType}`);
  }
}
class ED25519PublicKey {constructor() { ED25519PublicKey.prototype.__init.call(this); }
  __init() {this.keyType = _constantscjs.KeyType.ED25519}
  
}
class SECP256K1PublicKey {constructor() { SECP256K1PublicKey.prototype.__init2.call(this); }
  __init2() {this.keyType = _constantscjs.KeyType.SECP256K1}
  
}
function resolveEnumKeyName(keyType) {
  switch (keyType) {
    case _constantscjs.KeyType.ED25519: {
      return "ed25519Key";
    }
    case _constantscjs.KeyType.SECP256K1: {
      return "secp256k1Key";
    }
    default: {
      throw Error(`unknown type ${keyType}`);
    }
  }
}
class Enum {
  constructor(properties) {
    if (Object.keys(properties).length !== 1) {
      throw new Error("Enum can only take single value");
    }
    Object.keys(properties).map((key) => {
      this[key] = properties[key];
    });
  }
}
class PublicKey extends Enum {
  
  
  
  constructor(publicKey) {
    const keyName = resolveEnumKeyName(publicKey.keyType);
    super({ [keyName]: publicKey });
    this[keyName] = publicKey;
    this.enum = keyName;
  }
  /**
   * Creates a PublicKey instance from a string or an existing PublicKey instance.
   * @param value The string or PublicKey instance to create a PublicKey from.
   * @returns {PublicKey} The PublicKey instance.
   */
  static from(value) {
    if (typeof value === "string") {
      return PublicKey.fromString(value);
    }
    return value;
  }
  /**
   * Creates a PublicKey instance from an encoded key string.
   * @param encodedKey The encoded key string.
   * @returns {PublicKey} The PublicKey instance created from the encoded key string.
   */
  static fromString(encodedKey) {
    const parts = encodedKey.split(":");
    let publicKey;
    let keyType;
    if (parts.length === 1) {
      publicKey = parts[0];
    } else if (parts.length === 2) {
      publicKey = parts[1];
      keyType = str_to_key_type(parts[0]);
    } else {
      throw new Error("Invalid encoded key format, must be <curve>:<encoded key>");
    }
    const decodedPublicKey = _utils.baseDecode.call(void 0, publicKey);
    if (!keyType) {
      keyType = decodedPublicKey.length === _constantscjs.KeySize.SECP256k1_PUBLIC_KEY ? _constantscjs.KeyType.SECP256K1 : _constantscjs.KeyType.ED25519;
    }
    const keySize = keyType === _constantscjs.KeyType.ED25519 ? _constantscjs.KeySize.ED25519_PUBLIC_KEY : _constantscjs.KeySize.SECP256k1_PUBLIC_KEY;
    if (decodedPublicKey.length !== keySize) {
      throw new Error(`Invalid public key size (${decodedPublicKey.length}), must be ${keySize}`);
    }
    return new PublicKey({ keyType, data: decodedPublicKey });
  }
  /**
   * Returns a string representation of the public key.
   * @returns {string} The string representation of the public key.
   */
  toString() {
    const encodedKey = _utils.baseEncode.call(void 0, this.data);
    return `${key_type_to_str(this.keyType)}:${encodedKey}`;
  }
  /**
   * Verifies a message signature using the public key.
   * @param message The message to be verified.
   * @param signature The signature to be verified.
   * @returns {boolean} `true` if the signature is valid, otherwise `false`.
   */
  verify(message, signature) {
    const keyType = this.keyType;
    const data = this.data;
    switch (keyType) {
      case _constantscjs.KeyType.ED25519:
        return _ed25519.ed25519.verify(signature, message, data);
      case _constantscjs.KeyType.SECP256K1:
        return _secp256k12.default.ecdsaVerify(signature.subarray(0, 64), message, new Uint8Array([4, ...data]));
      default:
        throw new Error(`Unknown key type: ${keyType}`);
    }
  }
  get keyPair() {
    return this.ed25519Key || this.secp256k1Key;
  }
  get keyType() {
    return this.keyPair.keyType;
  }
  get data() {
    return this.keyPair.data;
  }
}


exports.PublicKey = PublicKey;

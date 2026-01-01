"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }var _utils = require('@near-js/utils');
var _randombytes = require('randombytes'); var _randombytes2 = _interopRequireDefault(_randombytes);
var _secp256k1 = require('secp256k1'); var _secp256k12 = _interopRequireDefault(_secp256k1);
var _constantscjs = require('./constants.cjs');
var _key_pair_basecjs = require('./key_pair_base.cjs');
var _public_keycjs = require('./public_key.cjs');
class KeyPairSecp256k1 extends _key_pair_basecjs.KeyPairBase {
  
  
  
  /**
   * Construct an instance of key pair given a secret key.
   * It's generally assumed that these are encoded in base58.
   * @param {string} extendedSecretKey
   */
  constructor(extendedSecretKey) {
    super();
    const decoded = _utils.baseDecode.call(void 0, extendedSecretKey);
    const secretKey = new Uint8Array(decoded.slice(0, _constantscjs.KeySize.SECRET_KEY));
    const withHeader = _secp256k12.default.publicKeyCreate(new Uint8Array(secretKey), false);
    const data = withHeader.subarray(1, withHeader.length);
    this.publicKey = new (0, _public_keycjs.PublicKey)({
      keyType: _constantscjs.KeyType.SECP256K1,
      data
    });
    this.secretKey = _utils.baseEncode.call(void 0, secretKey);
    this.extendedSecretKey = extendedSecretKey;
  }
  /**
   * Generate a new random keypair.
   * @example
   * const keyRandom = KeyPair.fromRandom();
   * keyRandom.publicKey
   * // returns [PUBLIC_KEY]
   *
   * keyRandom.secretKey
   * // returns [SECRET_KEY]
   */
  static fromRandom() {
    const secretKey = _randombytes2.default.call(void 0, _constantscjs.KeySize.SECRET_KEY);
    const withHeader = _secp256k12.default.publicKeyCreate(new Uint8Array(secretKey), false);
    const publicKey = withHeader.subarray(1, withHeader.length);
    const extendedSecretKey = new Uint8Array([...secretKey, ...publicKey]);
    return new KeyPairSecp256k1(_utils.baseEncode.call(void 0, extendedSecretKey));
  }
  sign(message) {
    const { signature, recid } = _secp256k12.default.ecdsaSign(message, _utils.baseDecode.call(void 0, this.secretKey));
    return { signature: new Uint8Array([...signature, recid]), publicKey: this.publicKey };
  }
  verify(message, signature) {
    return this.publicKey.verify(message, signature);
  }
  toString() {
    return `secp256k1:${this.extendedSecretKey}`;
  }
  getPublicKey() {
    return this.publicKey;
  }
}


exports.KeyPairSecp256k1 = KeyPairSecp256k1;

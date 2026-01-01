"use strict";Object.defineProperty(exports, "__esModule", {value: true}); function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }var _utils = require('@near-js/utils');
var _ed25519 = require('@noble/curves/ed25519');
var _randombytes = require('randombytes'); var _randombytes2 = _interopRequireDefault(_randombytes);
var _constantscjs = require('./constants.cjs');
var _key_pair_basecjs = require('./key_pair_base.cjs');
var _public_keycjs = require('./public_key.cjs');
class KeyPairEd25519 extends _key_pair_basecjs.KeyPairBase {
  
  
  
  /**
   * Construct an instance of key pair given a secret key.
   * It's generally assumed that these are encoded in base58.
   * @param extendedSecretKey
   */
  constructor(extendedSecretKey) {
    super();
    const decoded = _utils.baseDecode.call(void 0, extendedSecretKey);
    const secretKey = new Uint8Array(decoded.slice(0, _constantscjs.KeySize.SECRET_KEY));
    const publicKey = _ed25519.ed25519.getPublicKey(new Uint8Array(secretKey));
    this.publicKey = new (0, _public_keycjs.PublicKey)({ keyType: _constantscjs.KeyType.ED25519, data: publicKey });
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
    const publicKey = _ed25519.ed25519.getPublicKey(new Uint8Array(secretKey));
    const extendedSecretKey = new Uint8Array([...secretKey, ...publicKey]);
    return new KeyPairEd25519(_utils.baseEncode.call(void 0, extendedSecretKey));
  }
  /**
   * Signs a message using the key pair's secret key.
   * @param message The message to be signed.
   * @returns {Signature} The signature object containing the signature and the public key.
   */
  sign(message) {
    const signature = _ed25519.ed25519.sign(message, _utils.baseDecode.call(void 0, this.secretKey));
    return { signature, publicKey: this.publicKey };
  }
  /**
   * Verifies the signature of a message using the key pair's public key.
   * @param message The message to be verified.
   * @param signature The signature to be verified.
   * @returns {boolean} `true` if the signature is valid, otherwise `false`.
   */
  verify(message, signature) {
    return this.publicKey.verify(message, signature);
  }
  /**
   * Returns a string representation of the key pair in the format 'ed25519:[extendedSecretKey]'.
   * @returns {string} The string representation of the key pair.
   */
  toString() {
    return `ed25519:${this.extendedSecretKey}`;
  }
  /**
   * Retrieves the public key associated with the key pair.
   * @returns {PublicKey} The public key.
   */
  getPublicKey() {
    return this.publicKey;
  }
}


exports.KeyPairEd25519 = KeyPairEd25519;

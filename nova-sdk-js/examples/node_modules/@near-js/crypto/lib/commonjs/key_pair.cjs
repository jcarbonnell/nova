"use strict";Object.defineProperty(exports, "__esModule", {value: true});var _key_pair_basecjs = require('./key_pair_base.cjs');
var _key_pair_ed25519cjs = require('./key_pair_ed25519.cjs');
var _key_pair_secp256k1cjs = require('./key_pair_secp256k1.cjs');
class KeyPair extends _key_pair_basecjs.KeyPairBase {
  /**
   * @param curve Name of elliptical curve, case-insensitive
   * @returns Random KeyPair based on the curve
   */
  static fromRandom(curve) {
    switch (curve.toUpperCase()) {
      case "ED25519":
        return _key_pair_ed25519cjs.KeyPairEd25519.fromRandom();
      case "SECP256K1":
        return _key_pair_secp256k1cjs.KeyPairSecp256k1.fromRandom();
      default:
        throw new Error(`Unknown curve ${curve}`);
    }
  }
  /**
   * Creates a key pair from an encoded key string.
   * @param encodedKey The encoded key string.
   * @returns {KeyPair} The key pair created from the encoded key string.
   */
  static fromString(encodedKey) {
    const parts = encodedKey.split(":");
    if (parts.length === 2) {
      switch (parts[0].toUpperCase()) {
        case "ED25519":
          return new (0, _key_pair_ed25519cjs.KeyPairEd25519)(parts[1]);
        case "SECP256K1":
          return new (0, _key_pair_secp256k1cjs.KeyPairSecp256k1)(parts[1]);
        default:
          throw new Error(`Unknown curve: ${parts[0]}`);
      }
    } else {
      throw new Error("Invalid encoded key format, must be <curve>:<encoded key>");
    }
  }
}


exports.KeyPair = KeyPair;

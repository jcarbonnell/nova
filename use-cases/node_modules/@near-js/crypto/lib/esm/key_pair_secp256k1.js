import { baseDecode, baseEncode } from "@near-js/utils";
import randombytes from "randombytes";
import secp256k1 from "secp256k1";
import { KeySize, KeyType } from "./constants.js";
import { KeyPairBase } from "./key_pair_base.js";
import { PublicKey } from "./public_key.js";
class KeyPairSecp256k1 extends KeyPairBase {
  publicKey;
  secretKey;
  extendedSecretKey;
  /**
   * Construct an instance of key pair given a secret key.
   * It's generally assumed that these are encoded in base58.
   * @param {string} extendedSecretKey
   */
  constructor(extendedSecretKey) {
    super();
    const decoded = baseDecode(extendedSecretKey);
    const secretKey = new Uint8Array(decoded.slice(0, KeySize.SECRET_KEY));
    const withHeader = secp256k1.publicKeyCreate(new Uint8Array(secretKey), false);
    const data = withHeader.subarray(1, withHeader.length);
    this.publicKey = new PublicKey({
      keyType: KeyType.SECP256K1,
      data
    });
    this.secretKey = baseEncode(secretKey);
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
    const secretKey = randombytes(KeySize.SECRET_KEY);
    const withHeader = secp256k1.publicKeyCreate(new Uint8Array(secretKey), false);
    const publicKey = withHeader.subarray(1, withHeader.length);
    const extendedSecretKey = new Uint8Array([...secretKey, ...publicKey]);
    return new KeyPairSecp256k1(baseEncode(extendedSecretKey));
  }
  sign(message) {
    const { signature, recid } = secp256k1.ecdsaSign(message, baseDecode(this.secretKey));
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
export {
  KeyPairSecp256k1
};

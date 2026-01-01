import { KeyPair, KeyType } from "@near-js/crypto";
import { sha256 } from "@noble/hashes/sha256";
import {
  Nep413MessageSchema,
  Signer
} from "./signer.js";
import {
  SignedTransaction,
  encodeTransaction,
  Signature,
  SignedDelegate,
  encodeDelegateAction
} from "@near-js/transactions";
import { serialize } from "borsh";
class KeyPairSigner extends Signer {
  key;
  constructor(key) {
    super();
    this.key = key;
  }
  static fromSecretKey(encodedKey) {
    const key = KeyPair.fromString(encodedKey);
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
    const serializedPrefix = serialize("u32", PREFIX);
    const params = {
      message,
      recipient,
      nonce,
      callbackUrl
    };
    const serializedParams = serialize(Nep413MessageSchema, params);
    const serializedMessage = new Uint8Array(
      serializedPrefix.length + serializedParams.length
    );
    serializedMessage.set(serializedPrefix);
    serializedMessage.set(serializedParams, serializedPrefix.length);
    const hash = new Uint8Array(sha256(serializedMessage));
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
    const message = encodeTransaction(transaction);
    const hash = new Uint8Array(sha256(message));
    const { signature } = this.key.sign(hash);
    const signedTx = new SignedTransaction({
      transaction,
      signature: new Signature({
        keyType: transaction.publicKey.ed25519Key ? KeyType.ED25519 : KeyType.SECP256K1,
        data: signature
      })
    });
    return [hash, signedTx];
  }
  async signDelegateAction(delegateAction) {
    const pk = this.key.getPublicKey();
    if (delegateAction.publicKey.toString() !== pk.toString())
      throw new Error("The public key doesn't match the signer's key");
    const message = encodeDelegateAction(delegateAction);
    const hash = new Uint8Array(sha256(message));
    const { signature } = this.key.sign(hash);
    const signedDelegate = new SignedDelegate({
      delegateAction,
      signature: new Signature({
        keyType: pk.keyType,
        data: signature
      })
    });
    return [hash, signedDelegate];
  }
}
export {
  KeyPairSigner
};

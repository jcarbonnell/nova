import { Transaction } from "./schema.js";
function createTransaction(signerId, publicKey, receiverId, nonce, actions, blockHash) {
  const txNonce = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  return new Transaction({
    signerId,
    publicKey,
    nonce: txNonce,
    receiverId,
    actions,
    blockHash
  });
}
export {
  createTransaction
};

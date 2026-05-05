var KeyType = /* @__PURE__ */ ((KeyType2) => {
  KeyType2[KeyType2["ED25519"] = 0] = "ED25519";
  KeyType2[KeyType2["SECP256K1"] = 1] = "SECP256K1";
  return KeyType2;
})(KeyType || {});
const KeySize = {
  SECRET_KEY: 32,
  ED25519_PUBLIC_KEY: 32,
  SECP256k1_PUBLIC_KEY: 64
};
export {
  KeySize,
  KeyType
};

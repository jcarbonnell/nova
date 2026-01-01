/** All supported key types */
declare enum KeyType {
    ED25519 = 0,
    SECP256K1 = 1
}
declare const KeySize: {
    SECRET_KEY: number;
    ED25519_PUBLIC_KEY: number;
    SECP256k1_PUBLIC_KEY: number;
};
type CurveType = 'ed25519' | 'ED25519' | 'secp256k1' | 'SECP256K1';
type KeyPairString = `ed25519:${string}` | `secp256k1:${string}`;

export { type CurveType, type KeyPairString, KeySize, KeyType };

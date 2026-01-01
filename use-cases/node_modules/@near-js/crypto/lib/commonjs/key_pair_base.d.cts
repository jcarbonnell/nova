import { KeyPairString } from './constants.cjs';
import { PublicKey } from './public_key.cjs';

interface Signature {
    signature: Uint8Array;
    publicKey: PublicKey;
}
declare abstract class KeyPairBase {
    abstract sign(message: Uint8Array): Signature;
    abstract verify(message: Uint8Array, signature: Uint8Array): boolean;
    abstract toString(): KeyPairString;
    abstract getPublicKey(): PublicKey;
}

export { KeyPairBase, type Signature };

import { CurveType, KeyPairString } from './constants.js';
import { KeyPairBase } from './key_pair_base.js';
import './public_key.js';

declare abstract class KeyPair extends KeyPairBase {
    /**
     * @param curve Name of elliptical curve, case-insensitive
     * @returns Random KeyPair based on the curve
     */
    static fromRandom(curve: CurveType): KeyPair;
    /**
     * Creates a key pair from an encoded key string.
     * @param encodedKey The encoded key string.
     * @returns {KeyPair} The key pair created from the encoded key string.
     */
    static fromString(encodedKey: KeyPairString): KeyPair;
}

export { KeyPair };

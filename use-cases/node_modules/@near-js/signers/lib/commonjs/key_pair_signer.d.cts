import { KeyPair, KeyPairString, PublicKey } from '@near-js/crypto';
import { Signer, SignedMessage } from './signer.cjs';
import { Transaction, SignedTransaction, DelegateAction, SignedDelegate } from '@near-js/transactions';
import 'borsh';

/**
 * Signs using in memory key store.
 */
declare class KeyPairSigner extends Signer {
    private readonly key;
    constructor(key: KeyPair);
    static fromSecretKey(encodedKey: KeyPairString): KeyPairSigner;
    getPublicKey(): Promise<PublicKey>;
    signNep413Message(message: string, accountId: string, recipient: string, nonce: Uint8Array, callbackUrl?: string): Promise<SignedMessage>;
    signTransaction(transaction: Transaction): Promise<[Uint8Array, SignedTransaction]>;
    signDelegateAction(delegateAction: DelegateAction): Promise<[Uint8Array, SignedDelegate]>;
}

export { KeyPairSigner };

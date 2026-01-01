import { PublicKey } from '@near-js/crypto';
import { Transaction, SignedTransaction, DelegateAction, SignedDelegate } from '@near-js/transactions';
import { Schema } from 'borsh';

interface SignMessageParams {
    message: string;
    recipient: string;
    nonce: Uint8Array;
    callbackUrl?: string;
}
interface SignedMessage {
    accountId: string;
    publicKey: PublicKey;
    signature: Uint8Array;
    state?: string;
}
declare const Nep413MessageSchema: Schema;
/**
 * General signing interface, can be used for in memory signing, RPC singing, external wallet, HSM, etc.
 */
declare abstract class Signer {
    /**
     * Returns public key for given signer
     */
    abstract getPublicKey(): Promise<PublicKey>;
    /**
     * Signs given message according to NEP-413 requirements
     * @see https://github.com/near/NEPs/blob/master/neps/nep-0413.md
     *
     * @param params
     * @param accountId
     */
    abstract signNep413Message(message: string, accountId: string, recipient: string, nonce: Uint8Array, callbackUrl?: string): Promise<SignedMessage>;
    abstract signTransaction(transaction: Transaction): Promise<[Uint8Array, SignedTransaction]>;
    abstract signDelegateAction(delegateAction: DelegateAction): Promise<[Uint8Array, SignedDelegate]>;
}

export { Nep413MessageSchema, type SignMessageParams, type SignedMessage, Signer };

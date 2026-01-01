import { PublicKey } from '@near-js/crypto';
import { Schema } from 'borsh';
import { j as Action, k as DelegateAction, i as SignedDelegate } from './actions-Bj8sb-Lp.cjs';
import { Signature } from './signature.cjs';
import '@near-js/types';

/**
 * Borsh-encode a delegate action for inclusion as an action within a meta transaction
 * NB per NEP-461 this requires a Borsh-serialized prefix specific to delegate actions, ensuring
 *  signed delegate actions may never be identical to signed transactions with the same fields
 * @param delegateAction Delegate action to be signed by the meta transaction sender
 */
declare function encodeDelegateAction(delegateAction: DelegateAction): Uint8Array;
/**
 * Borsh-encode a signed delegate for validation and execution by a relayer
 * @param signedDelegate Signed delegate to be executed in a meta transaction
 */
declare function encodeSignedDelegate(signedDelegate: SignedDelegate): Uint8Array;
/**
 * Borsh-encode a transaction or signed transaction into a serialized form.
 * @param transaction The transaction or signed transaction object to be encoded.
 * @returns A serialized representation of the input transaction.
 */
declare function encodeTransaction(transaction: Transaction | SignedTransaction): Uint8Array;
/**
 * Borsh-decode a Transaction instance from a buffer
 * @param bytes Uint8Array data to be decoded
 */
declare function decodeTransaction(bytes: Uint8Array): Transaction;
/**
 * Borsh-decode a SignedTransaction instance from a buffer
 * @param bytes Uint8Array data to be decoded
 */
declare function decodeSignedTransaction(bytes: Uint8Array): SignedTransaction;
declare class Transaction {
    signerId: string;
    publicKey: PublicKey;
    nonce: bigint;
    receiverId: string;
    actions: Action[];
    blockHash: Uint8Array;
    constructor({ signerId, publicKey, nonce, receiverId, actions, blockHash }: {
        signerId: string;
        publicKey: PublicKey;
        nonce: bigint;
        receiverId: string;
        actions: Action[];
        blockHash: Uint8Array;
    });
    encode(): Uint8Array;
    static decode(bytes: Uint8Array): Transaction;
}
declare class SignedTransaction {
    transaction: Transaction;
    signature: Signature;
    constructor({ transaction, signature }: {
        transaction: Transaction;
        signature: Signature;
    });
    encode(): Uint8Array;
    static decode(bytes: Uint8Array): SignedTransaction;
}
declare const SCHEMA: {
    Ed25519Signature: Schema;
    Secp256k1Signature: Schema;
    Signature: Schema;
    Ed25519Data: Schema;
    Secp256k1Data: Schema;
    PublicKey: Schema;
    FunctionCallPermission: Schema;
    FullAccessPermission: Schema;
    AccessKeyPermission: Schema;
    AccessKey: Schema;
    CreateAccount: Schema;
    DeployContract: Schema;
    FunctionCall: Schema;
    Transfer: Schema;
    Stake: Schema;
    AddKey: Schema;
    DeleteKey: Schema;
    DeleteAccount: Schema;
    GlobalContractDeployMode: Schema;
    GlobalContractIdentifier: Schema;
    DeployGlobalContract: Schema;
    UseGlobalContract: Schema;
    DelegateActionPrefix: Schema;
    /** @todo: get rid of "ClassicActions" and keep only "Action" schema to be consistent with "nearcore" */
    ClassicActions: Schema;
    DelegateAction: Schema;
    SignedDelegate: Schema;
    Action: Schema;
    Transaction: Schema;
    SignedTransaction: Schema;
};

export { SCHEMA, SignedTransaction, Transaction, decodeSignedTransaction, decodeTransaction, encodeDelegateAction, encodeSignedDelegate, encodeTransaction };

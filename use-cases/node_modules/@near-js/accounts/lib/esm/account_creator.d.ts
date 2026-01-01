import { PublicKey } from '@near-js/crypto';
import { C as Connection } from './connection-DFhOVWYM.js';
import { Account } from './account.js';
import '@near-js/signers';
import '@near-js/providers';
import '@near-js/types';
import '@near-js/transactions';
import '@near-js/tokens';

/**
 * @deprecated Will be removed in the next major release
 *
 * Account creator provides an interface for implementations to actually create accounts
 */
declare abstract class AccountCreator {
    constructor();
    abstract createAccount(newAccountId: string, publicKey: PublicKey): Promise<void>;
}
/** @deprecated Will be removed in the next major release */
declare class LocalAccountCreator extends AccountCreator {
    readonly masterAccount: Account;
    readonly initialBalance: bigint;
    constructor(masterAccount: Account, initialBalance: bigint);
    /**
     * Creates an account using a masterAccount, meaning the new account is created from an existing account
     * @param newAccountId The name of the NEAR account to be created
     * @param publicKey The public key from the masterAccount used to create this account
     * @returns {Promise<void>}
     */
    createAccount(newAccountId: string, publicKey: PublicKey): Promise<void>;
}
/** @deprecated Will be removed in the next major release */
declare class UrlAccountCreator extends AccountCreator {
    readonly connection: Connection;
    readonly helperUrl: string;
    constructor(connection: Connection, helperUrl: string);
    /**
     * Creates an account using a helperUrl
     * This is [hosted here](https://helper.nearprotocol.com) or set up locally with the [near-contract-helper](https://github.com/nearprotocol/near-contract-helper) repository
     * @param newAccountId The name of the NEAR account to be created
     * @param publicKey The public key from the masterAccount used to create this account
     * @returns {Promise<void>}
     */
    createAccount(newAccountId: string, publicKey: PublicKey): Promise<void>;
}

export { AccountCreator, LocalAccountCreator, UrlAccountCreator };

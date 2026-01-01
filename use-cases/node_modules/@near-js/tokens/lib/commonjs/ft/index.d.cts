import { AccountLike } from '@near-js/types';

interface FTMetadata {
    spec?: string;
    name: string;
    decimals: number;
    symbol: string;
    icon?: string;
}
declare abstract class BaseFT {
    readonly metadata: FTMetadata;
    constructor(metadata: FTMetadata);
    /**
     * Converts a decimal number to indivisible units
     *
     * @param amount The amount in decimal format (e.g. "1.234")
     * @returns The amount in indivisible units (e.g. "1234")
     */
    toUnits(amount: string | number): bigint;
    /**
     * Converts indivisible units to a decimal number (represented as a string)
     *
     * @param units The amount in indivisible units (e.g. "1234")
     * @param precision (optional) number of digits shown to the right of the decimal point - rounded down
     * @returns The amount as a decimal string (e.g. "1.234")
     */
    toDecimal(amount: bigint | string | number, precision?: number): string;
    /**
     * Get the available balance of an account in indivisible units
     *
     * @param account The account to get the balance of
     * @returns
     */
    abstract getBalance(account: AccountLike): Promise<bigint>;
    /**
     * Transfer tokens from one account to another
     *
     * @param param
     * @param param.from The Account that will transfer the tokens
     * @param param.receiverId The AccountID that will receive the tokens
     * @param param.amount The amount of tokens to transfer in the smallest unit
     */
    abstract transfer({ from, receiverId, amount }: {
        from: AccountLike;
        receiverId: string;
        amount: string | number | bigint;
    }): Promise<any>;
}
declare class NativeToken extends BaseFT {
    constructor(metadata: FTMetadata);
    transfer({ from, receiverId, amount }: {
        from: AccountLike;
        receiverId: string;
        amount: string | number | bigint;
    }): Promise<any>;
    getBalance(account: AccountLike): Promise<bigint>;
}
declare class FungibleToken extends BaseFT {
    readonly accountId: string;
    constructor(accountId: string, metadata: FTMetadata);
    transfer({ from, receiverId, amount }: {
        from: AccountLike;
        receiverId: string;
        amount: string | number | bigint;
    }): Promise<any>;
    getBalance(account: AccountLike): Promise<bigint>;
    /**
     * Transfer tokens and call a function on the receiver contract,
     * only works if the receiver implements the `ft_on_transfer` method
     *
     * @param param
     * @param param.from The Account that will transfer the tokens
     * @param param.receiverId The AccountID that will receive the tokens
     * @param param.units The amount of tokens to transfer in the smallest unit
     * @param param.msg The message to send to the `ft_on_transfer` method
     */
    transferCall({ from, receiverId, amount, msg }: {
        from: AccountLike;
        receiverId: string;
        amount: bigint;
        msg: string;
    }): Promise<any>;
    /**
     * Register an account to the fungible token contract by paying a storage deposit
     *
     * @param param
     * @param param.accountIdToRegister The AccountID to register
     * @param param.fundingAccount The Account that will fund the registration
     */
    registerAccount({ accountIdToRegister, fundingAccount }: {
        accountIdToRegister: AccountLike;
        fundingAccount: AccountLike;
    }): Promise<any>;
    /**
     * Unregister an account from the fungible token contract by paying a storage deposit
     *
     * @param param
     * @param param.account The Account to unregister
     * @param param.force Whether to remove the account without claiming the storage deposit
     */
    unregisterAccount({ account, force }: {
        account: AccountLike;
        force: boolean;
    }): Promise<any>;
}
/**
 * The NEAR token is the native token of the NEAR blockchain
 */
declare const NEAR: NativeToken;

export { FungibleToken, NEAR, NativeToken };

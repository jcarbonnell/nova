import { AccountLike } from '@near-js/types';

declare class MultiTokenContract {
    readonly accountId: string;
    constructor(accountId: string);
    /**
     * Get the available balance of an account for the given token in indivisible units
     *
     * @param account The account to get the balance of
     * @param tokenId The token to retrieve the balance from
     * @returns The balance in the smallest unit as bigint
     */
    getBalance(account: AccountLike, tokenId: string): Promise<bigint>;
    /**
     * Get the available balances of an account for the given tokens in indivisible units
     *
     * @param account The account to get the balances of
     * @param tokenIds The tokens to retrieve the balances from
     * @returns The balances in the smallest unit as bigint[] matching the order of tokenIds
     */
    getBatchedBalance(account: AccountLike, tokenIds: string[]): Promise<bigint[]>;
    /**
     * Transfer tokens from one account to another
     *
     * @param param
     * @param param.from The Account that will transfer the tokens
     * @param param.receiverId The AccountID that will receive the tokens
     * @param param.tokenId The token to transfer
     * @param param.amount The amount of tokens to transfer in the smallest unit
     * @param param.approval Optional approval tuple [owner_id, approval_id]
     * @param param.memo Optional memo for indexing
     */
    transfer({ from, receiverId, tokenId, amount, approval, memo }: {
        from: AccountLike;
        receiverId: string;
        tokenId: string;
        amount: string | number | bigint;
        approval?: [owner_id: string, approval_id: number] | null;
        memo?: string | null;
    }): Promise<any>;
    /**
     * Transfer tokens and call a function on the receiver contract.
     * Only works if the receiver implements the `mt_on_transfer` method
     *
     * @param param
     * @param param.from The Account that will transfer the tokens
     * @param param.receiverId The AccountID that will receive the tokens
     * @param param.tokenId The token to transfer
     * @param param.amount The amount of tokens to transfer in the smallest unit
     * @param param.msg The message to send to the `mt_on_transfer` method
     * @param param.approval Optional approval tuple [owner_id, approval_id]
     * @param param.memo Optional memo for indexing
     */
    transferCall({ from, receiverId, tokenId, amount, msg, approval, memo }: {
        from: AccountLike;
        receiverId: string;
        tokenId: string;
        amount: bigint;
        msg: string;
        approval?: [owner_id: string, approval_id: number] | null;
        memo?: string | null;
    }): Promise<any>;
    /**
     * Transfer multiple tokens and amounts from one account to another
     *
     * @param param
     * @param param.from The Account that will transfer the tokens
     * @param param.receiverId The AccountID that will receive the tokens
     * @param param.tokenIds The tokens to transfer
     * @param param.amounts The amounts of each token to transfer in the smallest unit
     * @param param.approvals Optional array of approval tuples [owner_id, approval_id] or nulls per tokenId
     * @param param.memo Optional memo for indexing
     */
    batchTransfer({ from, receiverId, tokenIds, amounts, approvals, memo }: {
        from: AccountLike;
        receiverId: string;
        tokenIds: string[];
        amounts: Array<string | number | bigint>;
        approvals?: ([owner_id: string, approval_id: number] | null)[] | null;
        memo?: string | null;
    }): Promise<any>;
}

export { MultiTokenContract };

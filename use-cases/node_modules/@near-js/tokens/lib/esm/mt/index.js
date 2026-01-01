class MultiTokenContract {
  accountId;
  constructor(accountId) {
    this.accountId = accountId;
  }
  /**
   * Get the available balance of an account for the given token in indivisible units
   *
   * @param account The account to get the balance of
   * @param tokenId The token to retrieve the balance from
   * @returns The balance in the smallest unit as bigint
   */
  async getBalance(account, tokenId) {
    const balance = await account.provider.callFunction(
      this.accountId,
      "mt_balance_of",
      {
        account_id: account.accountId,
        token_id: tokenId
      }
    );
    return BigInt(balance);
  }
  /**
   * Get the available balances of an account for the given tokens in indivisible units
   *
   * @param account The account to get the balances of
   * @param tokenIds The tokens to retrieve the balances from
   * @returns The balances in the smallest unit as bigint[] matching the order of tokenIds
   */
  async getBatchedBalance(account, tokenIds) {
    const balances = await account.provider.callFunction(
      this.accountId,
      "mt_batch_balance_of",
      {
        account_id: account.accountId,
        token_ids: tokenIds
      }
    );
    return balances.map((b) => BigInt(b));
  }
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
  async transfer({ from, receiverId, tokenId, amount, approval = null, memo = null }) {
    return from.callFunction({
      contractId: this.accountId,
      methodName: "mt_transfer",
      args: {
        receiver_id: receiverId,
        token_id: tokenId,
        amount: amount.toString(),
        approval,
        memo
      },
      gas: "30000000000000",
      deposit: 1
    });
  }
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
  async transferCall({ from, receiverId, tokenId, amount, msg, approval = null, memo = null }) {
    return from.callFunction({
      contractId: this.accountId,
      methodName: "mt_transfer_call",
      args: {
        receiver_id: receiverId,
        token_id: tokenId,
        amount: amount.toString(),
        approval,
        memo,
        msg
      },
      gas: "30000000000000",
      deposit: 1
    });
  }
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
  async batchTransfer({ from, receiverId, tokenIds, amounts, approvals = null, memo = null }) {
    return from.callFunction({
      contractId: this.accountId,
      methodName: "mt_batch_transfer",
      args: {
        receiver_id: receiverId,
        token_ids: tokenIds,
        amounts: amounts.map((a) => a.toString()),
        approvals,
        memo
      },
      gas: "30000000000000",
      deposit: 1
    });
  }
}
export {
  MultiTokenContract
};

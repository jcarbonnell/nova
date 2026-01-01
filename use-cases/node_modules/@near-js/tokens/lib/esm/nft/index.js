class NFTContract {
  metadata;
  accountId;
  constructor(accountId, metadata) {
    metadata.spec = metadata.spec || "nft-1.0.0";
    this.metadata = metadata;
    this.accountId = accountId;
  }
  transfer({
    from,
    receiverId,
    tokenId
  }) {
    return from.callFunction({
      contractId: this.accountId,
      methodName: "nft_transfer",
      args: {
        receiver_id: receiverId,
        token_id: tokenId
      },
      deposit: 1,
      gas: 3e13
    });
  }
}
class NonFungibleToken {
  contractId;
  tokenId;
  ownerId;
  metadata;
  constructor(contractId, tokenId, ownerId, metadata) {
    this.contractId = contractId;
    this.tokenId = tokenId;
    this.ownerId = ownerId;
    this.metadata = metadata;
  }
}
export {
  NFTContract,
  NonFungibleToken
};

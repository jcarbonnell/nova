"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var account_exports = {};
__export(account_exports, {
  Account: () => Account,
  DEFAULT_WAIT_STATUS: () => DEFAULT_WAIT_STATUS
});
module.exports = __toCommonJS(account_exports);
var import_crypto = require("@near-js/crypto");
var import_providers = require("@near-js/providers");
var import_transactions = require("@near-js/transactions");
var import_types = require("@near-js/types");
var import_utils = require("@near-js/utils");
var import_connection = require('./connection.cjs');
var import_utils2 = require('./utils.cjs');
var import_tokens = require("@near-js/tokens");
var import_depd = __toESM(require("depd"), 1);
const {
  addKey,
  createAccount,
  deleteAccount,
  deleteKey,
  deployContract,
  deployGlobalContract,
  fullAccessKey,
  functionCall,
  functionCallAccessKey,
  transfer,
  useGlobalContract
} = import_transactions.actionCreators;
const DEFAULT_FINALITY = "optimistic";
const DEFAULT_WAIT_STATUS = "EXECUTED_OPTIMISTIC";
class Account {
  accountId;
  provider;
  signer;
  constructor(accountId, provider, signer) {
    this.accountId = accountId;
    this.provider = provider;
    this.signer = signer;
  }
  /**
   * Allows to set the signer used to control the account
   *
   * @param signer holds the private key and can sign Transactions
   */
  setSigner(signer) {
    this.signer = signer;
  }
  getSigner() {
    return this.signer;
  }
  /**
   * Returns an overview of the account's state, including the account's
   * balance, storage usage, and code hash
   */
  async getState() {
    const protocolConfig = await this.provider.experimental_protocolConfig({
      finality: DEFAULT_FINALITY
    });
    const state = await this.provider.viewAccount(this.accountId, {
      finality: DEFAULT_FINALITY
    });
    const costPerByte = BigInt(
      protocolConfig.runtime_config.storage_amount_per_byte
    );
    const usedOnStorage = BigInt(state.storage_usage) * costPerByte;
    const locked = BigInt(state.locked);
    const total = BigInt(state.amount) + locked;
    const available = total - (locked > usedOnStorage ? locked : usedOnStorage);
    return {
      balance: {
        total,
        usedOnStorage,
        locked,
        available
      },
      storageUsage: state.storage_usage,
      codeHash: state.code_hash
    };
  }
  /**
   * Calls {@link Provider.viewAccessKey} to retrieve information for a
   * specific key in the account
   */
  async getAccessKey(publicKey) {
    return this.provider.viewAccessKey(this.accountId, publicKey, {
      finality: DEFAULT_FINALITY
    });
  }
  /**
   * Calls {@link Provider.viewAccessKeyList} to retrieve the account's keys
   */
  async getAccessKeyList() {
    return this.provider.viewAccessKeyList(this.accountId, {
      finality: DEFAULT_FINALITY
    });
  }
  /**
   * Calls {@link Provider.viewContractCode} to retrieve the account's
   * contract code and its hash
   */
  async getContractCode() {
    return this.provider.viewContractCode(this.accountId, {
      finality: DEFAULT_FINALITY
    });
  }
  /**
   * Calls {@link Provider.viewContractState} to retrieve the keys and values
   * stored on the account's contract
   */
  async getContractState(prefix) {
    return this.provider.viewContractState(this.accountId, prefix, {
      finality: DEFAULT_FINALITY
    });
  }
  /**
   * Create a transaction that can be later signed with a {@link Signer}
   *
   * @param receiverId Account against which to perform the actions
   * @param actions Actions to perform
   * @param publicKey The public part of the key that will be used to sign the transaction
   */
  async createTransaction(receiverId, actions, publicKey) {
    if (!publicKey) throw new Error("Please provide a public key");
    const pk = import_crypto.PublicKey.from(publicKey);
    const accessKey = await this.getAccessKey(pk);
    const block = await this.provider.viewBlock({
      finality: DEFAULT_FINALITY
    });
    const recentBlockHash = block.header.hash;
    const nonce = BigInt(accessKey.nonce) + 1n;
    return (0, import_transactions.createTransaction)(
      this.accountId,
      pk,
      receiverId,
      nonce + 1n,
      actions,
      (0, import_utils.baseDecode)(recentBlockHash)
    );
  }
  /**
   * Create a signed transaction ready to be broadcast by a {@link Provider}
   */
  async createSignedTransaction(receiverId, actions) {
    if (!this.signer) throw new Error("Please set a signer");
    const tx = await this.createTransaction(
      receiverId,
      actions,
      await this.signer.getPublicKey()
    );
    const [, signedTx] = await this.signer.signTransaction(tx);
    return signedTx;
  }
  /**
   * Create a meta transaction ready to be signed by a {@link Signer}
   *
   * @param receiverId NEAR account receiving the transaction
   * @param actions list of actions to perform as part of the meta transaction
   * @param blockHeightTtl number of blocks after which a meta transaction will expire if not processed
   */
  async createMetaTransaction(receiverId, actions, blockHeightTtl = 200, publicKey) {
    if (!publicKey) throw new Error(`Please provide a public key`);
    const pk = import_crypto.PublicKey.from(publicKey);
    const accessKey = await this.getAccessKey(pk);
    const nonce = BigInt(accessKey.nonce) + 1n;
    const { header } = await this.provider.viewBlock({
      finality: DEFAULT_FINALITY
    });
    const maxBlockHeight = BigInt(header.height) + BigInt(blockHeightTtl);
    return (0, import_transactions.buildDelegateAction)({
      receiverId,
      senderId: this.accountId,
      actions,
      publicKey: pk,
      nonce,
      maxBlockHeight
    });
  }
  /**
   * Create a signed MetaTransaction that can be broadcasted to a relayer
   *
   * @param receiverId NEAR account receiving the transaction
   * @param actions list of actions to perform as part of the meta transaction
   * @param blockHeightTtl number of blocks after which a meta transaction will expire if not processed
   */
  async createSignedMetaTransaction(receiverId, actions, blockHeightTtl = 200) {
    if (!this.signer) throw new Error(`Please set a signer`);
    const delegateAction = await this.createMetaTransaction(
      receiverId,
      actions,
      blockHeightTtl,
      await this.signer.getPublicKey()
    );
    return this.signer.signDelegateAction(delegateAction);
  }
  /**
   * Creates a transaction, signs it and broadcast it to the network
   *
   * @param receiverId The NEAR account ID of the transaction receiver.
   * @param actions The list of actions to be performed in the transaction.
   * @param throwOnFailure Whether to throw an error if the transaction fails.
   * @returns {Promise<FinalExecutionOutcome>} A promise that resolves to the final execution outcome of the transaction.
   *
   */
  async signAndSendTransaction({
    receiverId,
    actions,
    waitUntil = DEFAULT_WAIT_STATUS,
    throwOnFailure = true
  }) {
    const signedTx = await this.createSignedTransaction(
      receiverId,
      actions
    );
    const result = await this.provider.sendTransactionUntil(
      signedTx,
      waitUntil
    );
    if (throwOnFailure && typeof result.status === "object" && typeof result.status.Failure === "object" && result.status.Failure !== null) {
      throw (0, import_utils.parseResultError)(result);
    }
    return result;
  }
  async signAndSendTransactions({
    transactions,
    waitUntil = DEFAULT_WAIT_STATUS,
    throwOnFailure = true
  }) {
    if (!this.signer) throw new Error("Please set a signer");
    const results = await Promise.all(
      transactions.map(async ({ receiverId, actions }) => {
        return this.signAndSendTransaction({
          receiverId,
          actions,
          waitUntil,
          throwOnFailure
        });
      })
    );
    return results;
  }
  /**
   * Creates a new NEAR account with a given ID and public key.
   * 
   * This method can create two types of accounts:
   * 
   * 1. Top-level accounts of the form `name.tla` (e.g., `bob.near`):
   * 
   * 2. Sub-accounts of the current account (e.g., `sub.ana.near`):
   *    - The new account ID must end with the current account ID
   *    - Example: If your account is `ana.near`, you can create `sub.ana.near`
   *
   * @param newAccountId the new account to create (e.g. bob.near or sub.ana.near)
   * @param publicKey the public part of the key that will control the account
   * @param nearToTransfer how much NEAR to transfer to the account in yoctoNEAR (default: 0)
   *
   */
  async createAccount(newAccountId, publicKey, nearToTransfer = "0") {
    if (newAccountId.endsWith(this.accountId)) {
      return this.createSubAccount(
        newAccountId,
        publicKey,
        nearToTransfer
      );
    }
    const splitted = newAccountId.split(".");
    if (splitted.length != 2) {
      throw new Error(
        "newAccountId needs to be of the form <string>.<tla>"
      );
    }
    const TLA = splitted[1];
    return this.signAndSendTransaction({
      receiverId: TLA,
      actions: [
        functionCall(
          "create_account",
          {
            new_account_id: newAccountId,
            new_public_key: publicKey.toString()
          },
          BigInt("60000000000000"),
          BigInt(nearToTransfer)
        )
      ]
    });
  }
  /**
   * Creates a sub account of this account. For example, if the account is
   * ana.near, you can create sub.ana.near.
   *
   * @param accountOrPrefix a prefix (e.g. `sub`) or the full sub-account (`sub.ana.near`)
   * @param publicKey the public part of the key that will control the account
   * @param nearToTransfer how much NEAR to transfer to the account (default: 0)
   *
   */
  async createSubAccount(accountOrPrefix, publicKey, nearToTransfer = "0") {
    if (!this.signer) throw new Error("Please set a signer");
    const newAccountId = accountOrPrefix.includes(".") ? accountOrPrefix : `${accountOrPrefix}.${this.accountId}`;
    if (newAccountId.length > 64) {
      throw new Error(`Accounts cannot exceed 64 characters`);
    }
    if (!newAccountId.endsWith(this.accountId)) {
      throw new Error(`New account must end up with ${this.accountId}`);
    }
    const actions = [
      createAccount(),
      transfer(BigInt(nearToTransfer)),
      addKey(import_crypto.PublicKey.from(publicKey), fullAccessKey())
    ];
    return this.signAndSendTransaction({
      receiverId: newAccountId,
      actions
    });
  }
  /**
   * Deletes the account, transferring all remaining NEAR to a beneficiary
   * account
   *
   * Important: Deleting an account does not transfer FTs or NFTs
   *
   * @param beneficiaryId Will receive the account's remaining balance
   */
  async deleteAccount(beneficiaryId) {
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [deleteAccount(beneficiaryId)]
    });
  }
  /**
   * Deploy a smart contract in the account
   *
   * @param code The compiled contract code bytes
   */
  async deployContract(code) {
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [deployContract(code)]
    });
  }
  /**
   * Deploy a global contract that can be reused by multiple accounts
   *
   * @param code The compiled contract code bytes
   * @param deployMode Deploy mode - "codeHash" for immutable contracts, "accountId" for updateable contracts
   */
  async deployGlobalContract(code, deployMode) {
    const mode = deployMode === "codeHash" ? new import_transactions.GlobalContractDeployMode({ CodeHash: null }) : new import_transactions.GlobalContractDeployMode({ AccountId: null });
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [deployGlobalContract(code, mode)]
    });
  }
  /**
   * Use a previously deployed global contract on this account
   *
   * @param contractIdentifier The global contract identifier - either { accountId: string } or { codeHash: string | Uint8Array }
   */
  async useGlobalContract(contractIdentifier) {
    const identifier = "accountId" in contractIdentifier ? new import_transactions.GlobalContractIdentifier({ AccountId: contractIdentifier.accountId }) : new import_transactions.GlobalContractIdentifier({
      CodeHash: typeof contractIdentifier.codeHash === "string" ? Buffer.from(contractIdentifier.codeHash, "hex") : contractIdentifier.codeHash
    });
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [useGlobalContract(identifier)]
    });
  }
  /**
   *
   * @param options
   * @param options.publicKey The key to add to the account
   * @param options.contractId The contract that this key can call
   * @param options.methodNames The methods this key is allowed to call
   * @param options.allowance The amount of NEAR this key can expend in gas
   * @returns
   */
  async addFunctionCallAccessKey({
    publicKey,
    contractId,
    methodNames = [],
    allowance = import_tokens.NEAR.toUnits("0.25")
  }) {
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [
        addKey(
          import_crypto.PublicKey.from(publicKey),
          functionCallAccessKey(
            contractId,
            methodNames,
            BigInt(allowance)
          )
        )
      ]
    });
  }
  /**
   * Add a full access key to the account
   *
   * @param publicKey The public key to be added
   * @returns {Promise<FinalExecutionOutcome>}
   */
  async addFullAccessKey(publicKey) {
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [addKey(import_crypto.PublicKey.from(publicKey), fullAccessKey())]
    });
  }
  /**
   * @param publicKey The public key to be deleted
   * @returns {Promise<FinalExecutionOutcome>}
   */
  async deleteKey(publicKey) {
    return this.signAndSendTransaction({
      receiverId: this.accountId,
      actions: [deleteKey(import_crypto.PublicKey.from(publicKey))]
    });
  }
  /**
   * Call a function on a smart contract and return parsed transaction result
   *
   * @param options
   * @param options.contractId The contract in which to call the function
   * @param options.methodName The method that will be called
   * @param options.args Arguments, either as a valid JSON Object or a raw Uint8Array
   * @param options.deposit (optional) Amount of NEAR Tokens to attach to the call (default 0)
   * @param options.gas (optional) Amount of GAS to use attach to the call (default 30TGas)
   * @param options.waitUntil (optional) Transaction finality to wait for (default INCLUDED_FINAL)
   * @returns
   */
  async callFunction(params) {
    const outcome = await this.callFunctionRaw(params);
    return (0, import_utils.getTransactionLastResult)(outcome);
  }
  /**
   * Call a function on a smart contract and return raw transaction outcome
   *
   * @param options
   * @param options.contractId The contract in which to call the function
   * @param options.methodName The method that will be called
   * @param options.args Arguments, either as a valid JSON Object or a raw Uint8Array
   * @param options.deposit (optional) Amount of NEAR Tokens to attach to the call (default 0)
   * @param options.gas (optional) Amount of GAS to use attach to the call (default 30TGas)
   * @param options.waitUntil (optional) Transaction finality to wait for (default INCLUDED_FINAL)
   * @returns {FinalExecutionOutcome}
   */
  async callFunctionRaw({
    contractId,
    methodName,
    args = {},
    deposit = "0",
    gas = import_utils.DEFAULT_FUNCTION_CALL_GAS,
    waitUntil = DEFAULT_WAIT_STATUS
  }) {
    return await this.signAndSendTransaction({
      receiverId: contractId,
      actions: [
        functionCall(methodName, args, BigInt(gas), BigInt(deposit))
      ],
      waitUntil
    });
  }
  /**
   * This function simply calls the `signNep413Message` method of the Signer
   *
   * @param options
   * @param options.message The message to be signed (e.g. "authenticating")
   * @param options.recipient Who will receive the message (e.g. auth.app.com)
   * @param options.nonce A challenge sent by the recipient
   * @param options.callbackUrl (optional) Deprecated parameter used only by browser wallets
   * @returns
   */
  async signNep413Message({
    message,
    recipient,
    nonce,
    callbackUrl
  }) {
    if (!this.signer) throw new Error("Please set a signer");
    return this.signer.signNep413Message(
      message,
      this.accountId,
      recipient,
      nonce,
      callbackUrl
    );
  }
  /**
   *
   * @param token The token to check the balance of. Defaults to Native NEAR.
   * @returns The available balance of the account in units (e.g. yoctoNEAR).
   */
  async getBalance(token = import_tokens.NEAR) {
    return token.getBalance(this);
  }
  /**
   * Transfers a token to the specified receiver.
   *
   * Supports sending either the native NEAR token or any supported Fungible Token (FT).
   *
   * @param amount - The amount of tokens to transfer in units (e.g. yoctoNEAR).
   * @param receiverId - The NEAR account ID of the receiver.
   * @param token - The token to transfer. Defaults to Native NEAR.
   *
   */
  async transfer({
    receiverId,
    amount,
    token = import_tokens.NEAR
  }) {
    return token.transfer({ from: this, receiverId, amount });
  }
  // DEPRECATED FUNCTIONS BELLOW - Please remove in next release
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.createSignedMetaTransaction} instead
   *
   * Compose and sign a SignedDelegate action to be executed in a transaction on behalf of this Account instance
   *
   * @param options Options for the transaction.
   * @param options.actions Actions to be included in the meta transaction
   * @param options.blockHeightTtl Number of blocks past the current block height for which the SignedDelegate action may be included in a meta transaction
   * @param options.receiverId Receiver account of the meta transaction
   */
  async signedDelegate({
    actions,
    blockHeightTtl,
    receiverId
  }) {
    const deprecate = (0, import_depd.default)("Account.signedDelegate()");
    deprecate("It will be removed in the next major release, please switch to Account.createSignedMetaTransaction()");
    const { header } = await this.provider.viewBlock({
      finality: DEFAULT_FINALITY
    });
    if (!this.signer) throw new Error(`Please set a signer`);
    const pk = await this.signer.getPublicKey();
    const accessKey = await this.getAccessKey(pk);
    const delegateAction = (0, import_transactions.buildDelegateAction)({
      actions,
      maxBlockHeight: BigInt(header.height) + BigInt(blockHeightTtl),
      nonce: BigInt(accessKey.nonce) + 1n,
      publicKey: pk,
      receiverId,
      senderId: this.accountId
    });
    const [, signedDelegate] = await this.signer.signDelegateAction(
      delegateAction
    );
    return signedDelegate;
  }
  /**
   * @deprecated Will be removed in the next major release, accounts no longer use Connections since it's deprecated too
   */
  getConnection() {
    return new import_connection.Connection("", this.provider, this.signer);
  }
  /** @hidden */
  validateArgs(args) {
    const isUint8Array = args.byteLength !== void 0 && args.byteLength === args.length;
    if (isUint8Array) {
      return;
    }
    if (Array.isArray(args) || typeof args !== "object") {
      throw new import_types.PositionalArgsError();
    }
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.callFunction} instead
   *
   * Execute a function call.
   * @param options The options for the function call.
   * @param options.contractId The NEAR account ID of the smart contract.
   * @param options.methodName The name of the method to be called on the smart contract.
   * @param options.args The arguments to be passed to the method.
   * @param options.gas The maximum amount of gas to be used for the function call.
   * @param options.attachedDeposit The amount of NEAR tokens to be attached to the function call.
   * @param options.walletMeta Metadata for wallet integration.
   * @param options.walletCallbackUrl The callback URL for wallet integration.
   * @param options.stringify A function to convert input arguments into bytes array
   * @returns {Promise<FinalExecutionOutcome>} A promise that resolves to the final execution outcome of the function call.
   */
  async functionCall({
    contractId,
    methodName,
    args = {},
    gas = import_utils.DEFAULT_FUNCTION_CALL_GAS,
    attachedDeposit,
    walletMeta,
    walletCallbackUrl,
    stringify
  }) {
    const deprecate = (0, import_depd.default)("Account.functionCall()");
    deprecate("It will be removed in the next major release, please switch to Account.callFunction()");
    this.validateArgs(args);
    const stringifyArg = stringify === void 0 ? import_transactions.stringifyJsonOrBytes : stringify;
    const functionCallArgs = [
      methodName,
      args,
      gas,
      attachedDeposit,
      stringifyArg,
      false
    ];
    return this.signAndSendTransactionLegacy({
      receiverId: contractId,
      // eslint-disable-next-line prefer-spread
      actions: [functionCall.apply(void 0, functionCallArgs)],
      walletMeta,
      walletCallbackUrl
    });
  }
  /**
   * @deprecated Will be removed in the next major release, use instead {@link Provider.viewTransactionStatus}
   */
  async getTransactionStatus(txHash) {
    const deprecate = (0, import_depd.default)("Account.getTransactionStatus()");
    deprecate("It will be removed in the next major release, please switch to Provider.viewTransactionStatus()");
    return this.provider.viewTransactionStatus(
      txHash,
      this.accountId,
      // accountId is used to determine on which shard to look for a tx
      "EXECUTED_OPTIMISTIC"
    );
  }
  /**
   * @deprecated Will be removed in the next major release, use ${@link Account.createSignedTransaction}
   * Create a signed transaction which can be broadcast to the network
   * @param receiverId NEAR account receiving the transaction
   * @param actions list of actions to perform as part of the transaction
   * @see {@link "@near-js/providers".json-rpc-provider.JsonRpcProvider.sendTransaction | JsonRpcProvider.sendTransaction}
   */
  async signTransaction(receiverId, actions, opts) {
    const deprecate = (0, import_depd.default)("Account.signTransaction()");
    deprecate("It will be removed in the next major release, please switch to Account.createSignedTransaction()");
    const signer = opts?.signer || this.signer;
    if (!signer) throw new Error(`Please set a signer`);
    const pk = await signer.getPublicKey();
    const accessKey = await this.getAccessKey(pk);
    const block = await this.provider.viewBlock({
      finality: DEFAULT_FINALITY
    });
    const recentBlockHash = block.header.hash;
    const nonce = BigInt(accessKey.nonce) + 1n;
    const tx = (0, import_transactions.createTransaction)(
      this.accountId,
      pk,
      receiverId,
      nonce + 1n,
      actions,
      (0, import_utils.baseDecode)(recentBlockHash)
    );
    return signer.signTransaction(tx);
  }
  /**
   * @deprecated Will be removed in the next major release, 
   * instead please create a transaction with
   * the actions bellow and broadcast it to the network
   * 1. createAccount
   * 2. transfer some tokens
   * 3. deployContract
   * 4. (optional) addKey
   * 5. (optional) functionCall to an initialization function
   *
   * Create a new account and deploy a contract to it
   * @param contractId NEAR account where the contract is deployed
   * @param publicKey The public key to add to the created contract account
   * @param data The compiled contract code
   * @param amount of NEAR to transfer to the created contract account. Transfer enough to pay for storage https://docs.near.org/docs/concepts/storage-staking
   */
  async createAndDeployContract(contractId, publicKey, data, amount) {
    const deprecate = (0, import_depd.default)("Account.createAndDeployContract()");
    deprecate("It will be removed in the next major release");
    const accessKey = fullAccessKey();
    await this.signAndSendTransactionLegacy({
      receiverId: contractId,
      actions: [
        createAccount(),
        transfer(amount),
        addKey(import_crypto.PublicKey.from(publicKey), accessKey),
        deployContract(data)
      ]
    });
    return new Account(contractId, this.provider);
  }
  /**
   * @deprecated Will be removed in the next major release, please instead use {@link Account.transfer}
   *
   * @param receiverId NEAR account receiving Ⓝ
   * @param amount Amount to send in yoctoⓃ
   */
  async sendMoney(receiverId, amount) {
    const deprecate = (0, import_depd.default)("Account.sendMoney()");
    deprecate("It will be removed in the next major release, please switch to Account.transfer()");
    return this.signAndSendTransactionLegacy({
      receiverId,
      actions: [transfer(amount)]
    });
  }
  /**
   * @deprecated Will be removed in the next major release, please instead use {@link Account.signAndSendTransaction}
   *
   * Sign a transaction to perform a list of actions and broadcast it using the RPC API.
   * @see {@link "@near-js/providers".json-rpc-provider.JsonRpcProvider | JsonRpcProvider }
   *
   * @param options The options for signing and sending the transaction.
   * @param options.receiverId The NEAR account ID of the transaction receiver.
   * @param options.actions The list of actions to be performed in the transaction.
   * @param options.returnError Whether to return an error if the transaction fails.
   * @returns {Promise<FinalExecutionOutcome>} A promise that resolves to the final execution outcome of the transaction.
   *
   */
  async signAndSendTransactionLegacy({ receiverId, actions, returnError }, opts) {
    const deprecate = (0, import_depd.default)("Account.signAndSendTransactionLegacy()");
    deprecate("It will be removed in the next major release, please switch to Account.signAndSendTransaction()");
    let txHash, signedTx;
    const TX_NONCE_RETRY_NUMBER = 12;
    const TX_NONCE_RETRY_WAIT = 500;
    const TX_NONCE_RETRY_WAIT_BACKOFF = 1.5;
    const result = await (0, import_providers.exponentialBackoff)(
      TX_NONCE_RETRY_WAIT,
      TX_NONCE_RETRY_NUMBER,
      TX_NONCE_RETRY_WAIT_BACKOFF,
      async () => {
        [txHash, signedTx] = await this.signTransaction(
          receiverId,
          actions,
          opts
        );
        try {
          return await this.provider.sendTransaction(signedTx);
        } catch (error) {
          if (error.type === "InvalidNonce") {
            import_utils.Logger.warn(
              `Retrying transaction ${receiverId}:${(0, import_utils.baseEncode)(
                txHash
              )} with new nonce.`
            );
            return null;
          }
          if (error.type === "Expired") {
            import_utils.Logger.warn(
              `Retrying transaction ${receiverId}:${(0, import_utils.baseEncode)(
                txHash
              )} due to expired block hash`
            );
            return null;
          }
          error.context = new import_types.ErrorContext((0, import_utils.baseEncode)(txHash));
          throw error;
        }
      }
    );
    if (!result) {
      throw new import_types.TypedError(
        "nonce retries exceeded for transaction. This usually means there are too many parallel requests with the same access key.",
        "RetriesExceeded"
      );
    }
    (0, import_utils.printTxOutcomeLogsAndFailures)({
      contractId: signedTx.transaction.receiverId,
      outcome: result
    });
    if (!returnError && typeof result.status === "object" && typeof result.status.Failure === "object" && result.status.Failure !== null) {
      if (result.status.Failure.error_message && result.status.Failure.error_type) {
        throw new import_types.TypedError(
          `Transaction ${result.transaction_outcome.id} failed. ${result.status.Failure.error_message}`,
          result.status.Failure.error_type
        );
      } else {
        throw (0, import_utils.parseResultError)(result);
      }
    }
    return result;
  }
  /** @hidden */
  accessKeyByPublicKeyCache = {};
  /**
   * @deprecated Will be removed in the next major release, accounts will no longer handle keystores
   *
   * Finds the {@link AccessKeyView} associated with the accounts {@link PublicKey} stored in the {@link "@near-js/keystores".keystore.KeyStore | Keystore}.
   *
   * @param receiverId currently unused
   * @param actions currently unused
   * @returns `{ publicKey PublicKey; accessKey: AccessKeyView }`
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async findAccessKey(receiverId, actions) {
    const deprecate = (0, import_depd.default)("Account.findAccessKey()");
    deprecate("It will be removed in the next major release");
    if (!this.signer) throw new Error(`Please set a signer`);
    const publicKey = await this.signer.getPublicKey();
    if (!publicKey) {
      throw new import_types.TypedError(
        `no matching key pair found in ${this.signer.constructor.name}`,
        "PublicKeyNotFound"
      );
    }
    const cachedAccessKey = this.accessKeyByPublicKeyCache[publicKey.toString()];
    if (cachedAccessKey !== void 0) {
      return { publicKey, accessKey: cachedAccessKey };
    }
    try {
      const rawAccessKey = await this.provider.query({
        request_type: "view_access_key",
        account_id: this.accountId,
        public_key: publicKey.toString(),
        finality: DEFAULT_FINALITY
      });
      const accessKey = {
        ...rawAccessKey,
        nonce: BigInt(rawAccessKey.nonce || 0)
      };
      if (this.accessKeyByPublicKeyCache[publicKey.toString()]) {
        return {
          publicKey,
          accessKey: this.accessKeyByPublicKeyCache[publicKey.toString()]
        };
      }
      this.accessKeyByPublicKeyCache[publicKey.toString()] = accessKey;
      return { publicKey, accessKey };
    } catch (e) {
      if (e.type == "AccessKeyDoesNotExist") {
        return null;
      }
      throw e;
    }
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.addFullAccessKey} or {@link Account.addFunctionAccessKey}
   *
   * @see [https://docs.near.org/concepts/basics/accounts/access-keys](https://docs.near.org/concepts/basics/accounts/access-keys)
   * @todo expand this API to support more options.
   * @param publicKey A public key to be associated with the contract
   * @param contractId NEAR account where the contract is deployed
   * @param methodNames The method names on the contract that should be allowed to be called. Pass null for no method names and '' or [] for any method names.
   * @param amount Payment in yoctoⓃ that is sent to the contract during this function call
   */
  async addKey(publicKey, contractId, methodNames, amount) {
    const deprecate = (0, import_depd.default)("Account.addKey()");
    deprecate("It will be removed in the next major release, please switch to either Account.addFullAccessKey(), or Account.addFunctionAccessKey()");
    if (!methodNames) {
      methodNames = [];
    }
    if (!Array.isArray(methodNames)) {
      methodNames = [methodNames];
    }
    let accessKey;
    if (!contractId) {
      accessKey = fullAccessKey();
    } else {
      accessKey = functionCallAccessKey(contractId, methodNames, amount);
    }
    return this.signAndSendTransactionLegacy({
      receiverId: this.accountId,
      actions: [addKey(import_crypto.PublicKey.from(publicKey), accessKey)]
    });
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Provider.callFunction} instead
   *
   * Invoke a contract view function using the RPC API.
   * @see [https://docs.near.org/api/rpc/contracts#call-a-contract-function](https://docs.near.org/api/rpc/contracts#call-a-contract-function)
   *
   * @param options Function call options.
   * @param options.contractId NEAR account where the contract is deployed
   * @param options.methodName The view-only method (no state mutations) name on the contract as it is written in the contract code
   * @param options.args Any arguments to the view contract method, wrapped in JSON
   * @param options.parse Parse the result of the call. Receives a Buffer (bytes array) and converts it to any object. By default result will be treated as json.
   * @param options.stringify Convert input arguments into a bytes array. By default the input is treated as a JSON.
   * @param options.blockQuery specifies which block to query state at. By default returns last DEFAULT_FINALITY block (i.e. not necessarily finalized).
   * @returns {Promise<any>}
   */
  async viewFunction(options) {
    const deprecate = (0, import_depd.default)("Account.viewFunction()");
    deprecate("It will be removed in the next major release, please switch to either Provider.callFunction()");
    return await (0, import_utils2.viewFunction)(this.getConnection(), options);
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.getContractState} instead
   *
   * Returns the state (key value pairs) of this account's contract based on the key prefix.
   * Pass an empty string for prefix if you would like to return the entire state.
   * @see [https://docs.near.org/api/rpc/contracts#view-contract-state](https://docs.near.org/api/rpc/contracts#view-contract-state)
   *
   * @param prefix allows to filter which keys should be returned. Empty prefix means all keys. String prefix is utf-8 encoded.
   * @param blockQuery specifies which block to query state at. By default returns last DEFAULT_FINALITY block (i.e. not necessarily finalized).
   */
  async viewState(prefix, blockQuery = { finality: DEFAULT_FINALITY }) {
    const deprecate = (0, import_depd.default)("Account.viewState()");
    deprecate("It will be removed in the next major release, please switch to either Account.getContractState()");
    return await (0, import_utils2.viewState)(
      this.getConnection(),
      this.accountId,
      prefix,
      blockQuery
    );
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.getAccessKeyList} instead
   *
   * Get all access keys for the account
   * @see [https://docs.near.org/api/rpc/access-keys#view-access-key-list](https://docs.near.org/api/rpc/access-keys#view-access-key-list)
   *
   */
  async getAccessKeys() {
    const deprecate = (0, import_depd.default)("Account.getAccessKeys()");
    deprecate("It will be removed in the next major release, please switch to either Account.getAccessKeyList()");
    const response = await this.provider.query({
      request_type: "view_access_key_list",
      account_id: this.accountId,
      finality: DEFAULT_FINALITY
    });
    return response?.keys?.map((key) => ({
      ...key,
      access_key: {
        ...key.access_key,
        nonce: BigInt(key.access_key.nonce)
      }
    }));
  }
  /**
   * @deprecated
   *
   * Returns a list of authorized apps
   * @todo update the response value to return all the different keys, not just app keys.
   *
   */
  async getAccountDetails() {
    const accessKeys = await this.getAccessKeys();
    const authorizedApps = accessKeys.filter((item) => item.access_key.permission !== "FullAccess").map((item) => {
      const perm = item.access_key.permission;
      return {
        contractId: perm.FunctionCall.receiver_id,
        amount: perm.FunctionCall.allowance,
        publicKey: item.public_key
      };
    });
    return { authorizedApps };
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.getState} instead
   *
   * Returns basic NEAR account information via the `view_account` RPC query method
   * @see [https://docs.near.org/api/rpc/contracts#view-account](https://docs.near.org/api/rpc/contracts#view-account)
   */
  async state() {
    const deprecate = (0, import_depd.default)("Account.state()");
    deprecate("It will be removed in the next major release, please switch to either Account.getState()");
    return this.provider.query({
      request_type: "view_account",
      account_id: this.accountId,
      finality: "optimistic"
    });
  }
  /**
   * @deprecated Will be removed in the next major release, please use {@link Account.getState} instead
   *
   */
  async getAccountBalance() {
    const deprecate = (0, import_depd.default)("Account.getAccountBalance()");
    deprecate("It will be removed in the next major release, please switch to either Account.getState()");
    const protocolConfig = await this.provider.experimental_protocolConfig({
      finality: DEFAULT_FINALITY
    });
    const state = await this.state();
    const costPerByte = BigInt(
      protocolConfig.runtime_config.storage_amount_per_byte
    );
    const stateStaked = BigInt(state.storage_usage) * costPerByte;
    const staked = BigInt(state.locked);
    const totalBalance = BigInt(state.amount) + staked;
    const availableBalance = totalBalance - (staked > stateStaked ? staked : stateStaked);
    return {
      total: totalBalance.toString(),
      stateStaked: stateStaked.toString(),
      staked: staked.toString(),
      available: availableBalance.toString()
    };
  }
  /**
   * Returns the NEAR tokens balance and validators of a given account that is delegated to the staking pools that are part of the validators set in the current epoch.
   *
   * @deprecated Will be removed in the next major release
   *
   * NOTE: If the tokens are delegated to a staking pool that is currently on pause or does not have enough tokens to participate in validation, they won't be accounted for.
   * @returns {Promise<ActiveDelegatedStakeBalance>}
   */
  async getActiveDelegatedStakeBalance() {
    const deprecate = (0, import_depd.default)("Account.getActiveDelegatedStakeBalance()");
    deprecate("It will be removed in the next major release");
    const block = await this.provider.block({
      finality: DEFAULT_FINALITY
    });
    const blockHash = block.header.hash;
    const epochId = block.header.epoch_id;
    const { current_validators, next_validators, current_proposals } = await this.provider.validators(epochId);
    const pools = /* @__PURE__ */ new Set();
    [
      ...current_validators,
      ...next_validators,
      ...current_proposals
    ].forEach((validator) => pools.add(validator.account_id));
    const uniquePools = [...pools];
    const promises = uniquePools.map(
      (validator) => this.viewFunction({
        contractId: validator,
        methodName: "get_account_total_balance",
        args: { account_id: this.accountId },
        blockQuery: { blockId: blockHash }
      })
    );
    const results = await Promise.allSettled(promises);
    const hasTimeoutError = results.some((result) => {
      if (result.status === "rejected" && result.reason.type === "TimeoutError") {
        return true;
      }
      return false;
    });
    if (hasTimeoutError) {
      throw new Error("Failed to get delegated stake balance");
    }
    const summary = results.reduce(
      (result, state, index) => {
        const validatorId = uniquePools[index];
        if (state.status === "fulfilled") {
          const currentBN = BigInt(state.value);
          if (currentBN !== 0n) {
            return {
              ...result,
              stakedValidators: [
                ...result.stakedValidators,
                { validatorId, amount: currentBN.toString() }
              ],
              total: result.total + currentBN
            };
          }
        }
        if (state.status === "rejected") {
          return {
            ...result,
            failedValidators: [
              ...result.failedValidators,
              { validatorId, error: state.reason }
            ]
          };
        }
        return result;
      },
      { stakedValidators: [], failedValidators: [], total: 0n }
    );
    return {
      ...summary,
      total: summary.total.toString()
    };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Account,
  DEFAULT_WAIT_STATUS
});

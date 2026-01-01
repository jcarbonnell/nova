import * as _near_js_transactions from '@near-js/transactions';
import { Action, SignedTransaction, DelegateAction, SignedDelegate } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import { Provider } from '@near-js/providers';
import { TxExecutionStatus, AccessKeyView, AccessKeyList, ContractCodeView, ContractStateView, FinalExecutionOutcome, SerializedReturnValue, BlockReference, AccessKeyInfoView, AccountView } from '@near-js/types';
import { Signer, SignedMessage } from '@near-js/signers';
import { C as Connection, a as ChangeFunctionCallOptions, V as ViewFunctionCallOptions } from './connection-DFhOVWYM.cjs';
import { NativeToken, FungibleToken } from '@near-js/tokens';

declare const DEFAULT_WAIT_STATUS: TxExecutionStatus;
interface AccountState {
    balance: {
        total: bigint;
        usedOnStorage: bigint;
        locked: bigint;
        available: bigint;
    };
    storageUsage: number;
    codeHash: string;
}
interface AccountBalance {
    total: string;
    stateStaked: string;
    staked: string;
    available: string;
}
interface AccountAuthorizedApp {
    contractId: string;
    amount: string;
    publicKey: string;
}
/**
 * Options used to initiate sining and sending transactions
 */
interface SignAndSendTransactionOptions {
    receiverId: string;
    actions: Action[];
    /**
     * Metadata to send the NEAR Wallet if using it to sign transactions.
     * @see RequestSignTransactionsOptions
     */
    walletMeta?: string;
    /**
     * Callback url to send the NEAR Wallet if using it to sign transactions.
     * @see RequestSignTransactionsOptions
     */
    walletCallbackUrl?: string;
    returnError?: boolean;
}
interface StakedBalance {
    validatorId: string;
    amount?: string;
    error?: string;
}
interface ActiveDelegatedStakeBalance {
    stakedValidators: StakedBalance[];
    failedValidators: StakedBalance[];
    total: bigint | string;
}
interface SignedDelegateOptions {
    actions: Action[];
    blockHeightTtl: number;
    receiverId: string;
}
/**
 * This class allows to access common account information.
 * If a {@link Signer} is provider, then the account can
 * be used to perform all common actions such as
 * transferring tokens and calling functions
 */
declare class Account {
    readonly accountId: string;
    readonly provider: Provider;
    private signer?;
    constructor(accountId: string, provider: Provider, signer?: Signer);
    /**
     * Allows to set the signer used to control the account
     *
     * @param signer holds the private key and can sign Transactions
     */
    setSigner(signer: Signer): void;
    getSigner(): Signer | undefined;
    /**
     * Returns an overview of the account's state, including the account's
     * balance, storage usage, and code hash
     */
    getState(): Promise<AccountState>;
    /**
     * Calls {@link Provider.viewAccessKey} to retrieve information for a
     * specific key in the account
     */
    getAccessKey(publicKey: PublicKey | string): Promise<AccessKeyView>;
    /**
     * Calls {@link Provider.viewAccessKeyList} to retrieve the account's keys
     */
    getAccessKeyList(): Promise<AccessKeyList>;
    /**
     * Calls {@link Provider.viewContractCode} to retrieve the account's
     * contract code and its hash
     */
    getContractCode(): Promise<ContractCodeView>;
    /**
     * Calls {@link Provider.viewContractState} to retrieve the keys and values
     * stored on the account's contract
     */
    getContractState(prefix?: string): Promise<ContractStateView>;
    /**
     * Create a transaction that can be later signed with a {@link Signer}
     *
     * @param receiverId Account against which to perform the actions
     * @param actions Actions to perform
     * @param publicKey The public part of the key that will be used to sign the transaction
     */
    createTransaction(receiverId: string, actions: Action[], publicKey: PublicKey | string): Promise<_near_js_transactions.Transaction>;
    /**
     * Create a signed transaction ready to be broadcast by a {@link Provider}
     */
    createSignedTransaction(receiverId: string, actions: Action[]): Promise<SignedTransaction>;
    /**
     * Create a meta transaction ready to be signed by a {@link Signer}
     *
     * @param receiverId NEAR account receiving the transaction
     * @param actions list of actions to perform as part of the meta transaction
     * @param blockHeightTtl number of blocks after which a meta transaction will expire if not processed
     */
    createMetaTransaction(receiverId: string, actions: Action[], blockHeightTtl: number, publicKey: PublicKey | string): Promise<DelegateAction>;
    /**
     * Create a signed MetaTransaction that can be broadcasted to a relayer
     *
     * @param receiverId NEAR account receiving the transaction
     * @param actions list of actions to perform as part of the meta transaction
     * @param blockHeightTtl number of blocks after which a meta transaction will expire if not processed
     */
    createSignedMetaTransaction(receiverId: string, actions: Action[], blockHeightTtl?: number): Promise<[Uint8Array, SignedDelegate]>;
    /**
     * Creates a transaction, signs it and broadcast it to the network
     *
     * @param receiverId The NEAR account ID of the transaction receiver.
     * @param actions The list of actions to be performed in the transaction.
     * @param throwOnFailure Whether to throw an error if the transaction fails.
     * @returns {Promise<FinalExecutionOutcome>} A promise that resolves to the final execution outcome of the transaction.
     *
     */
    signAndSendTransaction({ receiverId, actions, waitUntil, throwOnFailure, }: {
        receiverId: string;
        actions: Action[];
        waitUntil?: TxExecutionStatus;
        throwOnFailure?: boolean;
    }): Promise<FinalExecutionOutcome>;
    signAndSendTransactions({ transactions, waitUntil, throwOnFailure, }: {
        transactions: {
            receiverId: string;
            actions: Action[];
        }[];
        waitUntil?: TxExecutionStatus;
        throwOnFailure?: boolean;
    }): Promise<FinalExecutionOutcome[]>;
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
    createAccount(newAccountId: string, publicKey: PublicKey | string, nearToTransfer?: bigint | string | number): Promise<FinalExecutionOutcome>;
    /**
     * Creates a sub account of this account. For example, if the account is
     * ana.near, you can create sub.ana.near.
     *
     * @param accountOrPrefix a prefix (e.g. `sub`) or the full sub-account (`sub.ana.near`)
     * @param publicKey the public part of the key that will control the account
     * @param nearToTransfer how much NEAR to transfer to the account (default: 0)
     *
     */
    createSubAccount(accountOrPrefix: string, publicKey: PublicKey | string, nearToTransfer?: bigint | string | number): Promise<FinalExecutionOutcome>;
    /**
     * Deletes the account, transferring all remaining NEAR to a beneficiary
     * account
     *
     * Important: Deleting an account does not transfer FTs or NFTs
     *
     * @param beneficiaryId Will receive the account's remaining balance
     */
    deleteAccount(beneficiaryId: string): Promise<FinalExecutionOutcome>;
    /**
     * Deploy a smart contract in the account
     *
     * @param code The compiled contract code bytes
     */
    deployContract(code: Uint8Array): Promise<FinalExecutionOutcome>;
    /**
     * Deploy a global contract that can be reused by multiple accounts
     *
     * @param code The compiled contract code bytes
     * @param deployMode Deploy mode - "codeHash" for immutable contracts, "accountId" for updateable contracts
     */
    deployGlobalContract(code: Uint8Array, deployMode: "codeHash" | "accountId"): Promise<FinalExecutionOutcome>;
    /**
     * Use a previously deployed global contract on this account
     *
     * @param contractIdentifier The global contract identifier - either { accountId: string } or { codeHash: string | Uint8Array }
     */
    useGlobalContract(contractIdentifier: {
        accountId: string;
    } | {
        codeHash: string | Uint8Array;
    }): Promise<FinalExecutionOutcome>;
    /**
     *
     * @param options
     * @param options.publicKey The key to add to the account
     * @param options.contractId The contract that this key can call
     * @param options.methodNames The methods this key is allowed to call
     * @param options.allowance The amount of NEAR this key can expend in gas
     * @returns
     */
    addFunctionCallAccessKey({ publicKey, contractId, methodNames, allowance, }: {
        publicKey: PublicKey | string;
        contractId: string;
        methodNames: string[];
        allowance: bigint | string | number;
    }): Promise<FinalExecutionOutcome>;
    /**
     * Add a full access key to the account
     *
     * @param publicKey The public key to be added
     * @returns {Promise<FinalExecutionOutcome>}
     */
    addFullAccessKey(publicKey: PublicKey | string): Promise<FinalExecutionOutcome>;
    /**
     * @param publicKey The public key to be deleted
     * @returns {Promise<FinalExecutionOutcome>}
     */
    deleteKey(publicKey: PublicKey | string): Promise<FinalExecutionOutcome>;
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
    callFunction<T extends SerializedReturnValue>(params: {
        contractId: string;
        methodName: string;
        args: Uint8Array | Record<string, any>;
        deposit?: bigint | string | number;
        gas?: bigint | string | number;
        waitUntil?: TxExecutionStatus;
    }): Promise<T>;
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
    callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil, }: {
        contractId: string;
        methodName: string;
        args: Uint8Array | Record<string, any>;
        deposit?: bigint | string | number;
        gas?: bigint | string | number;
        waitUntil?: TxExecutionStatus;
    }): Promise<FinalExecutionOutcome>;
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
    signNep413Message({ message, recipient, nonce, callbackUrl, }: {
        message: string;
        recipient: string;
        nonce: Uint8Array;
        callbackUrl?: string;
    }): Promise<SignedMessage>;
    /**
     *
     * @param token The token to check the balance of. Defaults to Native NEAR.
     * @returns The available balance of the account in units (e.g. yoctoNEAR).
     */
    getBalance(token?: NativeToken | FungibleToken): Promise<bigint>;
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
    transfer({ receiverId, amount, token, }: {
        receiverId: string;
        amount: bigint | string | number;
        token?: NativeToken | FungibleToken;
    }): Promise<FinalExecutionOutcome>;
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
    signedDelegate({ actions, blockHeightTtl, receiverId, }: SignedDelegateOptions): Promise<SignedDelegate>;
    /**
     * @deprecated Will be removed in the next major release, accounts no longer use Connections since it's deprecated too
     */
    getConnection(): Connection;
    /** @hidden */
    private validateArgs;
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
    functionCall({ contractId, methodName, args, gas, attachedDeposit, walletMeta, walletCallbackUrl, stringify, }: ChangeFunctionCallOptions): Promise<FinalExecutionOutcome>;
    /**
     * @deprecated Will be removed in the next major release, use instead {@link Provider.viewTransactionStatus}
     */
    getTransactionStatus(txHash: string | Uint8Array): Promise<FinalExecutionOutcome>;
    /**
     * @deprecated Will be removed in the next major release, use ${@link Account.createSignedTransaction}
     * Create a signed transaction which can be broadcast to the network
     * @param receiverId NEAR account receiving the transaction
     * @param actions list of actions to perform as part of the transaction
     * @see {@link "@near-js/providers".json-rpc-provider.JsonRpcProvider.sendTransaction | JsonRpcProvider.sendTransaction}
     */
    signTransaction(receiverId: string, actions: Action[], opts?: {
        signer: Signer;
    }): Promise<[Uint8Array, SignedTransaction]>;
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
    createAndDeployContract(contractId: string, publicKey: string | PublicKey, data: Uint8Array, amount: bigint): Promise<Account>;
    /**
     * @deprecated Will be removed in the next major release, please instead use {@link Account.transfer}
     *
     * @param receiverId NEAR account receiving Ⓝ
     * @param amount Amount to send in yoctoⓃ
     */
    sendMoney(receiverId: string, amount: bigint): Promise<FinalExecutionOutcome>;
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
    signAndSendTransactionLegacy({ receiverId, actions, returnError }: SignAndSendTransactionOptions, opts?: {
        signer: Signer;
    }): Promise<FinalExecutionOutcome>;
    /** @hidden */
    accessKeyByPublicKeyCache: {
        [key: string]: AccessKeyView;
    };
    /**
     * @deprecated Will be removed in the next major release, accounts will no longer handle keystores
     *
     * Finds the {@link AccessKeyView} associated with the accounts {@link PublicKey} stored in the {@link "@near-js/keystores".keystore.KeyStore | Keystore}.
     *
     * @param receiverId currently unused
     * @param actions currently unused
     * @returns `{ publicKey PublicKey; accessKey: AccessKeyView }`
     */
    findAccessKey(receiverId: string, actions: Action[]): Promise<{
        publicKey: PublicKey;
        accessKey: AccessKeyView;
    }>;
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
    addKey(publicKey: string | PublicKey, contractId?: string, methodNames?: string | string[], amount?: bigint): Promise<FinalExecutionOutcome>;
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
    viewFunction(options: ViewFunctionCallOptions): Promise<any>;
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
    viewState(prefix: string | Uint8Array, blockQuery?: BlockReference): Promise<Array<{
        key: Buffer;
        value: Buffer;
    }>>;
    /**
     * @deprecated Will be removed in the next major release, please use {@link Account.getAccessKeyList} instead
     *
     * Get all access keys for the account
     * @see [https://docs.near.org/api/rpc/access-keys#view-access-key-list](https://docs.near.org/api/rpc/access-keys#view-access-key-list)
     *
     */
    getAccessKeys(): Promise<AccessKeyInfoView[]>;
    /**
     * @deprecated
     *
     * Returns a list of authorized apps
     * @todo update the response value to return all the different keys, not just app keys.
     *
     */
    getAccountDetails(): Promise<{
        authorizedApps: AccountAuthorizedApp[];
    }>;
    /**
     * @deprecated Will be removed in the next major release, please use {@link Account.getState} instead
     *
     * Returns basic NEAR account information via the `view_account` RPC query method
     * @see [https://docs.near.org/api/rpc/contracts#view-account](https://docs.near.org/api/rpc/contracts#view-account)
     */
    state(): Promise<AccountView>;
    /**
     * @deprecated Will be removed in the next major release, please use {@link Account.getState} instead
     *
     */
    getAccountBalance(): Promise<AccountBalance>;
    /**
     * Returns the NEAR tokens balance and validators of a given account that is delegated to the staking pools that are part of the validators set in the current epoch.
     *
     * @deprecated Will be removed in the next major release
     *
     * NOTE: If the tokens are delegated to a staking pool that is currently on pause or does not have enough tokens to participate in validation, they won't be accounted for.
     * @returns {Promise<ActiveDelegatedStakeBalance>}
     */
    getActiveDelegatedStakeBalance(): Promise<ActiveDelegatedStakeBalance>;
}

export { Account, type AccountAuthorizedApp, type AccountBalance, type AccountState, DEFAULT_WAIT_STATUS, type SignAndSendTransactionOptions };

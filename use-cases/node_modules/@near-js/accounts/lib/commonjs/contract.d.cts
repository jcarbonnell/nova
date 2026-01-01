import { LocalViewExecution } from './local-view-execution/index.cjs';
import { AbiRoot } from 'near-abi';
import { Account } from './account.cjs';
import { C as Connection, I as IntoConnection } from './connection-DFhOVWYM.cjs';
import '@near-js/types';
import '@near-js/transactions';
import '@near-js/crypto';
import '@near-js/providers';
import '@near-js/signers';
import '@near-js/tokens';

interface ContractMethods {
    /**
     * Methods that change state. These methods cost gas and require a signed transaction.
     *
     * @see {@link Account#functionCall}
     */
    changeMethods: string[];
    /**
     * View methods do not require a signed transaction.
     *
     * @see {@link Account#viewFunction}
     */
    viewMethods: string[];
    /**
     * ABI defining this contract's interface.
     */
    abi?: AbiRoot;
    /**
     * Executes view methods locally. This flag is useful when multiple view calls will be made for the same blockId
     */
    useLocalViewExecution: boolean;
}
/**
 * @deprecated It will be removed in the next major release, please switch to {@link TypedContract} with type-safe ABI support
 *
 * Defines a smart contract on NEAR including the change (mutable) and view (non-mutable) methods
 *
 * @see [https://docs.near.org/tools/near-api-js/quick-reference#contract](https://docs.near.org/tools/near-api-js/quick-reference#contract)
 * @example
 * ```js
 * import { Contract } from 'near-api-js';
 *
 * async function contractExample() {
 *   const methodOptions = {
 *     viewMethods: ['getMessageByAccountId'],
 *     changeMethods: ['addMessage']
 *   };
 *   const contract = new Contract(
 *     wallet.account(),
 *     'contract-id.testnet',
 *     methodOptions
 *   );
 *
 *   // use a contract view method
 *   const messages = await contract.getMessages({
 *     accountId: 'example-account.testnet'
 *   });
 *
 *   // use a contract change method
 *   await contract.addMessage({
 *      meta: 'some info',
 *      callbackUrl: 'https://example.com/callback',
 *      args: { text: 'my message' },
 *      amount: 1
 *   })
 * }
 * ```
 */
declare class Contract {
    /** @deprecated */
    readonly account?: Account;
    readonly connection: Connection;
    readonly contractId: string;
    readonly lve: LocalViewExecution;
    /**
     * @param account NEAR account to sign change method transactions
     * @param contractId NEAR account id where the contract is deployed
     * @param options NEAR smart contract methods that your application will use. These will be available as `contract.methodName`
     */
    constructor(connection: IntoConnection, contractId: string, options: ContractMethods);
    private _changeMethod;
}

export { Contract, type ContractMethods };

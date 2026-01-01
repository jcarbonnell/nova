import { Signer } from '@near-js/signers';
import { Provider } from '@near-js/providers';
import { BlockReference } from '@near-js/types';

interface IntoConnection {
    getConnection(): Connection;
}
/**
 * @deprecated Will be removed in the next major release
 *
 * Options used to initiate a function call (especially a change function call)
 * @see {@link Account#viewFunction | viewFunction} to initiate a view function call
 */
interface FunctionCallOptions {
    /** The NEAR account id where the contract is deployed */
    contractId: string;
    /** The name of the method to invoke */
    methodName: string;
    /**
     * named arguments to pass the method `{ messageText: 'my message' }`
     */
    args?: object;
    /** max amount of gas that method call can use */
    gas?: bigint;
    /** amount of NEAR (in yoctoNEAR) to send together with the call */
    attachedDeposit?: bigint;
    /**
     * Convert input arguments into bytes array.
     */
    stringify?: (input: any) => Buffer;
}
/** @deprecated Will be removed in the next major release */
interface ChangeFunctionCallOptions extends FunctionCallOptions {
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
}
/** @deprecated Will be removed in the next major release */
interface ViewFunctionCallOptions extends FunctionCallOptions {
    parse?: (response: Uint8Array) => any;
    blockQuery?: BlockReference;
}

/**
 * @deprecated Will be removed in the next major release
 *
 * Connects an account to a given network via a given provider
 */
declare class Connection implements IntoConnection {
    readonly networkId: string;
    readonly provider: Provider;
    readonly signer: Signer;
    constructor(networkId: string, provider: Provider, signer: Signer);
    getConnection(): Connection;
    /**
     * @param config Contains connection info details
     */
    static fromConfig(config: any): Connection;
}

export { Connection as C, type FunctionCallOptions as F, type IntoConnection as I, type ViewFunctionCallOptions as V, type ChangeFunctionCallOptions as a };

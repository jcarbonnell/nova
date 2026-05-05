import { PublicKey } from '@near-js/crypto';
import { Enum } from '@near-js/types';
import { Signature } from './signature.cjs';

declare class DelegateAction {
    senderId: string;
    receiverId: string;
    actions: Array<Action>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: PublicKey;
    constructor({ senderId, receiverId, actions, nonce, maxBlockHeight, publicKey }: {
        senderId: string;
        receiverId: string;
        actions: Action[];
        nonce: bigint;
        maxBlockHeight: bigint;
        publicKey: PublicKey;
    });
}
/**
 * Compose a delegate action for inclusion with a meta transaction signed on the sender's behalf
 * @param actions The set of actions to be included in the meta transaction
 * @param maxBlockHeight The maximum block height for which this action can be executed as part of a transaction
 * @param nonce Current nonce on the access key used to sign the delegate action
 * @param publicKey Public key for the access key used to sign the delegate action
 * @param receiverId Account ID for the intended receiver of the meta transaction
 * @param senderId Account ID for the intended signer of the delegate action
 */
declare function buildDelegateAction({ actions, maxBlockHeight, nonce, publicKey, receiverId, senderId, }: DelegateAction): DelegateAction;

declare class FunctionCallPermission {
    allowance?: bigint;
    receiverId: string;
    methodNames: string[];
    constructor({ allowance, receiverId, methodNames }: {
        allowance: bigint;
        receiverId: string;
        methodNames: string[];
    });
}
declare class FullAccessPermission {
}
declare class AccessKeyPermission extends Enum {
    enum: string;
    functionCall?: FunctionCallPermission;
    fullAccess?: FullAccessPermission;
    constructor(props: any);
}
declare class AccessKey {
    nonce: bigint;
    permission: AccessKeyPermission;
    constructor({ nonce, permission }: {
        nonce: bigint;
        permission: AccessKeyPermission;
    });
}
declare class CreateAccount {
}
declare class DeployContract {
    code: Uint8Array;
    constructor({ code }: {
        code: Uint8Array;
    });
}
declare class FunctionCall {
    methodName: string;
    args: Uint8Array;
    gas: bigint;
    deposit: bigint;
    constructor({ methodName, args, gas, deposit }: {
        methodName: string;
        args: Uint8Array;
        gas: bigint;
        deposit: bigint;
    });
}
declare class GlobalContractDeployMode extends Enum {
    enum: string;
    CodeHash?: null;
    AccountId?: null;
    constructor(props: {
        CodeHash?: null;
        AccountId?: null;
    });
}
declare class GlobalContractIdentifier extends Enum {
    enum: string;
    CodeHash?: Uint8Array;
    AccountId?: string;
    constructor(props: {
        CodeHash?: Uint8Array;
        AccountId?: string;
    });
}
declare class DeployGlobalContract {
    code: Uint8Array;
    deployMode: GlobalContractDeployMode;
    constructor({ code, deployMode }: {
        code: Uint8Array;
        deployMode: GlobalContractDeployMode;
    });
}
declare class UseGlobalContract {
    contractIdentifier: GlobalContractIdentifier;
    constructor({ contractIdentifier }: {
        contractIdentifier: GlobalContractIdentifier;
    });
}
declare class Transfer {
    deposit: bigint;
    constructor({ deposit }: {
        deposit: bigint;
    });
}
declare class Stake {
    stake: bigint;
    publicKey: PublicKey;
    constructor({ stake, publicKey }: {
        stake: bigint;
        publicKey: PublicKey;
    });
}
declare class AddKey {
    publicKey: PublicKey;
    accessKey: AccessKey;
    constructor({ publicKey, accessKey }: {
        publicKey: PublicKey;
        accessKey: AccessKey;
    });
}
declare class DeleteKey {
    publicKey: PublicKey;
    constructor({ publicKey }: {
        publicKey: PublicKey;
    });
}
declare class DeleteAccount {
    beneficiaryId: string;
    constructor({ beneficiaryId }: {
        beneficiaryId: string;
    });
}
declare class SignedDelegate {
    delegateAction: DelegateAction;
    signature: Signature;
    constructor({ delegateAction, signature }: {
        delegateAction: DelegateAction;
        signature: Signature;
    });
}
/**
 * Contains a list of the valid transaction Actions available with this API
 * @see {@link https://nomicon.io/RuntimeSpec/Actions.html | Actions Spec}
 */
declare class Action extends Enum {
    enum: string;
    createAccount?: CreateAccount;
    deployContract?: DeployContract;
    functionCall?: FunctionCall;
    transfer?: Transfer;
    stake?: Stake;
    addKey?: AddKey;
    deleteKey?: DeleteKey;
    deleteAccount?: DeleteAccount;
    signedDelegate?: SignedDelegate;
    deployGlobalContract?: DeployGlobalContract;
    useGlobalContract?: UseGlobalContract;
    constructor(props: any);
}

export { AccessKeyPermission as A, CreateAccount as C, DeployContract as D, FunctionCallPermission as F, GlobalContractDeployMode as G, Stake as S, Transfer as T, UseGlobalContract as U, FullAccessPermission as a, AccessKey as b, FunctionCall as c, GlobalContractIdentifier as d, DeployGlobalContract as e, AddKey as f, DeleteKey as g, DeleteAccount as h, SignedDelegate as i, Action as j, DelegateAction as k, buildDelegateAction as l };

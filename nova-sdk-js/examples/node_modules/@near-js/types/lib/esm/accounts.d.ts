interface ProviderLike {
    callFunction: (contractId: any, methodName: any, args: any, blockQuery?: any) => Promise<any>;
}
interface AccountLike {
    accountId: string;
    provider: ProviderLike;
    getState(): Promise<any>;
    signAndSendTransaction({ receiverId, actions }: {
        receiverId: any;
        actions: any;
    }): Promise<any>;
    callFunction({ contractId, methodName, args, gas, deposit }: {
        contractId: any;
        methodName: any;
        args: any;
        gas: any;
        deposit: any;
    }): Promise<any>;
}

export type { AccountLike };

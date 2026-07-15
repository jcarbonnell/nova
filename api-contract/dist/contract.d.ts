import { z } from 'zod';
export declare const getOwnedGroups: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{}, z.core.$strip>, z.ZodObject<{
    result: z.ZodArray<z.ZodString>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const authStatus: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodObject<{
        authenticated: z.ZodBoolean;
        near_account_id: z.ZodString;
        group_id: z.ZodString;
        authorized_for_group: z.ZodOptional<z.ZodBoolean>;
        auth_error: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const getMemberGroups: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{}, z.core.$strip>, z.ZodObject<{
    result: z.ZodArray<z.ZodString>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const getGroupMembers: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodArray<z.ZodString>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const getGroupTransactions: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodArray<z.ZodObject<{
        group_id: z.ZodString;
        user_id: z.ZodString;
        file_hash: z.ZodString;
        ipfs_hash: z.ZodString;
    }, z.core.$loose>>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const registerGroup: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodString;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const addGroupMember: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
    member_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodString;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const revokeGroupMember: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
    member_id: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodString;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const prepareUpload: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
    filename: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodObject<{
        upload_id: z.ZodString;
        key: z.ZodString;
        group_id: z.ZodString;
        filename: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const finalizeUpload: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    upload_id: z.ZodString;
    encrypted_data: z.ZodString;
    file_hash: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodObject<{
        cid: z.ZodString;
        trans_id: z.ZodString;
        file_hash: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const prepareRetrieve: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
    group_id: z.ZodString;
    ipfs_hash: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    result: z.ZodObject<{
        key: z.ZodString;
        encrypted_b64: z.ZodString;
        ipfs_hash: z.ZodString;
        group_id: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>, Record<never, never>, Record<never, never>>;
export declare const contract: {
    getOwnedGroups: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{}, z.core.$strip>, z.ZodObject<{
        result: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    authStatus: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodObject<{
            authenticated: z.ZodBoolean;
            near_account_id: z.ZodString;
            group_id: z.ZodString;
            authorized_for_group: z.ZodOptional<z.ZodBoolean>;
            auth_error: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    getMemberGroups: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{}, z.core.$strip>, z.ZodObject<{
        result: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    getGroupMembers: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodArray<z.ZodString>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    getGroupTransactions: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodArray<z.ZodObject<{
            group_id: z.ZodString;
            user_id: z.ZodString;
            file_hash: z.ZodString;
            ipfs_hash: z.ZodString;
        }, z.core.$loose>>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    registerGroup: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodString;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    addGroupMember: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
        member_id: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodString;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    revokeGroupMember: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
        member_id: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodString;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    prepareUpload: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
        filename: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodObject<{
            upload_id: z.ZodString;
            key: z.ZodString;
            group_id: z.ZodString;
            filename: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    finalizeUpload: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        upload_id: z.ZodString;
        encrypted_data: z.ZodString;
        file_hash: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodObject<{
            cid: z.ZodString;
            trans_id: z.ZodString;
            file_hash: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
    prepareRetrieve: import("@orpc/contract").ContractProcedureBuilderWithInputOutput<z.ZodObject<{
        group_id: z.ZodString;
        ipfs_hash: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        result: z.ZodObject<{
            key: z.ZodString;
            encrypted_b64: z.ZodString;
            ipfs_hash: z.ZodString;
            group_id: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>, Record<never, never>, Record<never, never>>;
};
export type NovaContract = typeof contract;

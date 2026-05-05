// src/errors/rpc_errors.ts
import { TypedError } from "@near-js/types";
import Mustache from "mustache";

// src/format.ts
import { base58 } from "@scure/base";
var NEAR_NOMINATION_EXP = 24;
var NEAR_NOMINATION = 10n ** BigInt(NEAR_NOMINATION_EXP);
var ROUNDING_OFFSETS = [];
var BN10 = 10n;
for (let i = 0, offset = 5n; i < NEAR_NOMINATION_EXP; i++, offset = offset * BN10) {
  ROUNDING_OFFSETS[i] = offset;
}
function formatNearAmount(balance, fracDigits = NEAR_NOMINATION_EXP) {
  let balanceBN = BigInt(balance);
  if (fracDigits !== NEAR_NOMINATION_EXP) {
    const roundingExp = NEAR_NOMINATION_EXP - fracDigits - 1;
    if (roundingExp > 0) {
      balanceBN += ROUNDING_OFFSETS[roundingExp];
    }
  }
  balance = balanceBN.toString();
  const wholeStr = balance.substring(0, balance.length - NEAR_NOMINATION_EXP) || "0";
  const fractionStr = balance.substring(balance.length - NEAR_NOMINATION_EXP).padStart(NEAR_NOMINATION_EXP, "0").substring(0, fracDigits);
  return trimTrailingZeroes(`${formatWithCommas(wholeStr)}.${fractionStr}`);
}
function trimTrailingZeroes(value) {
  return value.replace(/\.?0*$/, "");
}
function formatWithCommas(value) {
  const pattern = /(-?\d+)(\d{3})/;
  while (pattern.test(value)) {
    value = value.replace(pattern, "$1,$2");
  }
  return value;
}

// src/errors/error_messages.json
var error_messages_default = {
  GasLimitExceeded: "Exceeded the maximum amount of gas allowed to burn per contract",
  MethodEmptyName: "Method name is empty",
  WasmerCompileError: "Wasmer compilation error: {{msg}}",
  GuestPanic: "Smart contract panicked: {{panic_msg}}",
  Memory: "Error creating Wasm memory",
  GasExceeded: "Exceeded the prepaid gas",
  MethodUTF8Error: "Method name is not valid UTF8 string",
  BadUTF16: "String encoding is bad UTF-16 sequence",
  WasmTrap: "WebAssembly trap: {{msg}}",
  GasInstrumentation: "Gas instrumentation failed or contract has denied instructions.",
  InvalidPromiseIndex: "{{promise_idx}} does not correspond to existing promises",
  InvalidPromiseResultIndex: "Accessed invalid promise result index: {{result_idx}}",
  Deserialization: "Error happened while deserializing the module",
  MethodNotFound: "Contract method is not found",
  InvalidRegisterId: "Accessed invalid register id: {{register_id}}",
  InvalidReceiptIndex: "VM Logic returned an invalid receipt index: {{receipt_index}}",
  EmptyMethodName: "Method name is empty in contract call",
  CannotReturnJointPromise: "Returning joint promise is currently prohibited",
  StackHeightInstrumentation: "Stack instrumentation failed",
  CodeDoesNotExist: "Cannot find contract code for account {{account_id}}",
  MethodInvalidSignature: "Invalid method signature",
  IntegerOverflow: "Integer overflow happened during contract execution",
  MemoryAccessViolation: "MemoryAccessViolation",
  InvalidIteratorIndex: "Iterator index {{iterator_index}} does not exist",
  IteratorWasInvalidated: "Iterator {{iterator_index}} was invalidated after its creation by performing a mutable operation on trie",
  InvalidAccountId: "VM Logic returned an invalid account id",
  Serialization: "Error happened while serializing the module",
  CannotAppendActionToJointPromise: "Actions can only be appended to non-joint promise.",
  InternalMemoryDeclared: "Internal memory declaration has been found in the module",
  Instantiate: "Error happened during instantiation",
  ProhibitedInView: "{{method_name}} is not allowed in view calls",
  InvalidMethodName: "VM Logic returned an invalid method name",
  BadUTF8: "String encoding is bad UTF-8 sequence",
  BalanceExceeded: "Exceeded the account balance",
  LinkError: "Wasm contract link error: {{msg}}",
  InvalidPublicKey: "VM Logic provided an invalid public key",
  ActorNoPermission: "Actor {{actor_id}} doesn't have permission to account {{account_id}} to complete the action",
  LackBalanceForState: "The account {{account_id}} wouldn't have enough balance to cover storage, required to have {{amount}} yoctoNEAR more",
  ReceiverMismatch: "Wrong AccessKey used for transaction: transaction is sent to receiver_id={{tx_receiver}}, but is signed with function call access key that restricted to only use with receiver_id={{ak_receiver}}. Either change receiver_id in your transaction or switch to use a FullAccessKey.",
  CostOverflow: "Transaction gas or balance cost is too high",
  InvalidSignature: "Transaction is not signed with the given public key",
  AccessKeyNotFound: `Signer "{{account_id}}" doesn't have access key with the given public_key {{public_key}}`,
  NotEnoughBalance: "Sender {{signer_id}} does not have enough balance {{#formatNear}}{{balance}}{{/formatNear}} for operation costing {{#formatNear}}{{cost}}{{/formatNear}}",
  NotEnoughAllowance: "Access Key {account_id}:{public_key} does not have enough balance {{#formatNear}}{{allowance}}{{/formatNear}} for transaction costing {{#formatNear}}{{cost}}{{/formatNear}}",
  Expired: "Transaction has expired",
  DeleteAccountStaking: "Account {{account_id}} is staking and can not be deleted",
  SignerDoesNotExist: "Signer {{signer_id}} does not exist",
  TriesToStake: "Account {{account_id}} tried to stake {{#formatNear}}{{stake}}{{/formatNear}}, but has staked {{#formatNear}}{{locked}}{{/formatNear}} and only has {{#formatNear}}{{balance}}{{/formatNear}}",
  AddKeyAlreadyExists: "The public key {{public_key}} is already used for an existing access key",
  InvalidSigner: "Invalid signer account ID {{signer_id}} according to requirements",
  CreateAccountNotAllowed: "The new account_id {{account_id}} can't be created by {{predecessor_id}}",
  RequiresFullAccess: "The transaction contains more then one action, but it was signed with an access key which allows transaction to apply only one specific action. To apply more then one actions TX must be signed with a full access key",
  TriesToUnstake: "Account {{account_id}} is not yet staked, but tried to unstake",
  InvalidNonce: "Transaction nonce {{tx_nonce}} must be larger than nonce of the used access key {{ak_nonce}}",
  AccountAlreadyExists: "Can't create a new account {{account_id}}, because it already exists",
  InvalidChain: "Transaction parent block hash doesn't belong to the current chain",
  AccountDoesNotExist: "Can't complete the action because account {{account_id}} doesn't exist",
  AccessKeyDoesNotExist: "Can't complete the action because access key {{public_key}} doesn't exist",
  MethodNameMismatch: "Transaction method name {{method_name}} isn't allowed by the access key",
  DeleteAccountHasRent: "Account {{account_id}} can't be deleted. It has {{#formatNear}}{{balance}}{{/formatNear}}, which is enough to cover the rent",
  DeleteAccountHasEnoughBalance: "Account {{account_id}} can't be deleted. It has {{#formatNear}}{{balance}}{{/formatNear}}, which is enough to cover it's storage",
  InvalidReceiver: "Invalid receiver account ID {{receiver_id}} according to requirements",
  DeleteKeyDoesNotExist: "Account {{account_id}} tries to remove an access key that doesn't exist",
  Timeout: "Timeout exceeded",
  Closed: "Connection closed",
  ShardCongested: "Shard {{shard_id}} rejected the transaction due to congestion level {{congestion_level}}, try again later",
  ShardStuck: "Shard {{shard_id}} rejected the transaction because it missed {{missed_chunks}} chunks and needs to recover before accepting new transactions, try again later"
};

// src/errors/errors.ts
var ErrorMessages = error_messages_default;

// src/errors/rpc_error_schema.json
var rpc_error_schema_default = {
  schema: {
    AccessKeyNotFound: {
      name: "AccessKeyNotFound",
      subtypes: [],
      props: {
        account_id: "",
        public_key: ""
      }
    },
    AccountAlreadyExists: {
      name: "AccountAlreadyExists",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    AccountDoesNotExist: {
      name: "AccountDoesNotExist",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    ActionError: {
      name: "ActionError",
      subtypes: [
        "AccountAlreadyExists",
        "AccountDoesNotExist",
        "CreateAccountOnlyByRegistrar",
        "CreateAccountNotAllowed",
        "ActorNoPermission",
        "DeleteKeyDoesNotExist",
        "AddKeyAlreadyExists",
        "DeleteAccountStaking",
        "LackBalanceForState",
        "TriesToUnstake",
        "TriesToStake",
        "InsufficientStake",
        "FunctionCallError",
        "NewReceiptValidationError",
        "OnlyImplicitAccountCreationAllowed",
        "DeleteAccountWithLargeState",
        "DelegateActionInvalidSignature",
        "DelegateActionSenderDoesNotMatchTxReceiver",
        "DelegateActionExpired",
        "DelegateActionAccessKeyError",
        "DelegateActionInvalidNonce",
        "DelegateActionNonceTooLarge"
      ],
      props: {
        index: ""
      }
    },
    ActionsValidationError: {
      name: "ActionsValidationError",
      subtypes: [
        "DeleteActionMustBeFinal",
        "TotalPrepaidGasExceeded",
        "TotalNumberOfActionsExceeded",
        "AddKeyMethodNamesNumberOfBytesExceeded",
        "AddKeyMethodNameLengthExceeded",
        "IntegerOverflow",
        "InvalidAccountId",
        "ContractSizeExceeded",
        "FunctionCallMethodNameLengthExceeded",
        "FunctionCallArgumentsLengthExceeded",
        "UnsuitableStakingKey",
        "FunctionCallZeroAttachedGas",
        "DelegateActionMustBeOnlyOne",
        "UnsupportedProtocolFeature"
      ],
      props: {}
    },
    ActorNoPermission: {
      name: "ActorNoPermission",
      subtypes: [],
      props: {
        account_id: "",
        actor_id: ""
      }
    },
    AddKeyAlreadyExists: {
      name: "AddKeyAlreadyExists",
      subtypes: [],
      props: {
        account_id: "",
        public_key: ""
      }
    },
    AddKeyMethodNameLengthExceeded: {
      name: "AddKeyMethodNameLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    AddKeyMethodNamesNumberOfBytesExceeded: {
      name: "AddKeyMethodNamesNumberOfBytesExceeded",
      subtypes: [],
      props: {
        limit: "",
        total_number_of_bytes: ""
      }
    },
    AltBn128InvalidInput: {
      name: "AltBn128InvalidInput",
      subtypes: [],
      props: {
        msg: ""
      }
    },
    BadUTF16: {
      name: "BadUTF16",
      subtypes: [],
      props: {}
    },
    BadUTF8: {
      name: "BadUTF8",
      subtypes: [],
      props: {}
    },
    BalanceExceeded: {
      name: "BalanceExceeded",
      subtypes: [],
      props: {}
    },
    BalanceMismatchError: {
      name: "BalanceMismatchError",
      subtypes: [],
      props: {
        final_accounts_balance: "",
        final_postponed_receipts_balance: "",
        forwarded_buffered_receipts_balance: "",
        incoming_receipts_balance: "",
        incoming_validator_rewards: "",
        initial_accounts_balance: "",
        initial_postponed_receipts_balance: "",
        new_buffered_receipts_balance: "",
        new_delayed_receipts_balance: "",
        other_burnt_amount: "",
        outgoing_receipts_balance: "",
        processed_delayed_receipts_balance: "",
        slashed_burnt_amount: "",
        tx_burnt_amount: ""
      }
    },
    CallIndirectOOB: {
      name: "CallIndirectOOB",
      subtypes: [],
      props: {}
    },
    CannotAppendActionToJointPromise: {
      name: "CannotAppendActionToJointPromise",
      subtypes: [],
      props: {}
    },
    CannotReturnJointPromise: {
      name: "CannotReturnJointPromise",
      subtypes: [],
      props: {}
    },
    CodeDoesNotExist: {
      name: "CodeDoesNotExist",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    CompilationError: {
      name: "CompilationError",
      subtypes: [
        "CodeDoesNotExist",
        "PrepareError",
        "WasmerCompileError"
      ],
      props: {}
    },
    ContractSizeExceeded: {
      name: "ContractSizeExceeded",
      subtypes: [],
      props: {
        limit: "",
        size: ""
      }
    },
    CostOverflow: {
      name: "CostOverflow",
      subtypes: [],
      props: {}
    },
    CreateAccountNotAllowed: {
      name: "CreateAccountNotAllowed",
      subtypes: [],
      props: {
        account_id: "",
        predecessor_id: ""
      }
    },
    CreateAccountOnlyByRegistrar: {
      name: "CreateAccountOnlyByRegistrar",
      subtypes: [],
      props: {
        account_id: "",
        predecessor_id: "",
        registrar_account_id: ""
      }
    },
    DelegateActionExpired: {
      name: "DelegateActionExpired",
      subtypes: [],
      props: {}
    },
    DelegateActionInvalidNonce: {
      name: "DelegateActionInvalidNonce",
      subtypes: [],
      props: {
        ak_nonce: "",
        delegate_nonce: ""
      }
    },
    DelegateActionInvalidSignature: {
      name: "DelegateActionInvalidSignature",
      subtypes: [],
      props: {}
    },
    DelegateActionMustBeOnlyOne: {
      name: "DelegateActionMustBeOnlyOne",
      subtypes: [],
      props: {}
    },
    DelegateActionNonceTooLarge: {
      name: "DelegateActionNonceTooLarge",
      subtypes: [],
      props: {
        delegate_nonce: "",
        upper_bound: ""
      }
    },
    DelegateActionSenderDoesNotMatchTxReceiver: {
      name: "DelegateActionSenderDoesNotMatchTxReceiver",
      subtypes: [],
      props: {
        receiver_id: "",
        sender_id: ""
      }
    },
    DeleteAccountStaking: {
      name: "DeleteAccountStaking",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    DeleteAccountWithLargeState: {
      name: "DeleteAccountWithLargeState",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    DeleteActionMustBeFinal: {
      name: "DeleteActionMustBeFinal",
      subtypes: [],
      props: {}
    },
    DeleteKeyDoesNotExist: {
      name: "DeleteKeyDoesNotExist",
      subtypes: [],
      props: {
        account_id: "",
        public_key: ""
      }
    },
    DepositWithFunctionCall: {
      name: "DepositWithFunctionCall",
      subtypes: [],
      props: {}
    },
    Deprecated: {
      name: "Deprecated",
      subtypes: [],
      props: {
        method_name: ""
      }
    },
    Deserialization: {
      name: "Deserialization",
      subtypes: [],
      props: {}
    },
    ECRecoverError: {
      name: "ECRecoverError",
      subtypes: [],
      props: {
        msg: ""
      }
    },
    Ed25519VerifyInvalidInput: {
      name: "Ed25519VerifyInvalidInput",
      subtypes: [],
      props: {
        msg: ""
      }
    },
    EmptyMethodName: {
      name: "EmptyMethodName",
      subtypes: [],
      props: {}
    },
    Expired: {
      name: "Expired",
      subtypes: [],
      props: {}
    },
    FunctionCallArgumentsLengthExceeded: {
      name: "FunctionCallArgumentsLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    FunctionCallMethodNameLengthExceeded: {
      name: "FunctionCallMethodNameLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    FunctionCallZeroAttachedGas: {
      name: "FunctionCallZeroAttachedGas",
      subtypes: [],
      props: {}
    },
    GasExceeded: {
      name: "GasExceeded",
      subtypes: [],
      props: {}
    },
    GasInstrumentation: {
      name: "GasInstrumentation",
      subtypes: [],
      props: {}
    },
    GasLimitExceeded: {
      name: "GasLimitExceeded",
      subtypes: [],
      props: {}
    },
    GenericTrap: {
      name: "GenericTrap",
      subtypes: [],
      props: {}
    },
    GuestPanic: {
      name: "GuestPanic",
      subtypes: [],
      props: {
        panic_msg: ""
      }
    },
    HostError: {
      name: "HostError",
      subtypes: [
        "BadUTF16",
        "BadUTF8",
        "GasExceeded",
        "GasLimitExceeded",
        "BalanceExceeded",
        "EmptyMethodName",
        "GuestPanic",
        "IntegerOverflow",
        "InvalidPromiseIndex",
        "CannotAppendActionToJointPromise",
        "CannotReturnJointPromise",
        "InvalidPromiseResultIndex",
        "InvalidRegisterId",
        "IteratorWasInvalidated",
        "MemoryAccessViolation",
        "InvalidReceiptIndex",
        "InvalidIteratorIndex",
        "InvalidAccountId",
        "InvalidMethodName",
        "InvalidPublicKey",
        "ProhibitedInView",
        "NumberOfLogsExceeded",
        "KeyLengthExceeded",
        "ValueLengthExceeded",
        "TotalLogLengthExceeded",
        "NumberPromisesExceeded",
        "NumberInputDataDependenciesExceeded",
        "ReturnedValueLengthExceeded",
        "ContractSizeExceeded",
        "Deprecated",
        "ECRecoverError",
        "AltBn128InvalidInput",
        "Ed25519VerifyInvalidInput"
      ],
      props: {}
    },
    IllegalArithmetic: {
      name: "IllegalArithmetic",
      subtypes: [],
      props: {}
    },
    IncorrectCallIndirectSignature: {
      name: "IncorrectCallIndirectSignature",
      subtypes: [],
      props: {}
    },
    IndirectCallToNull: {
      name: "IndirectCallToNull",
      subtypes: [],
      props: {}
    },
    Instantiate: {
      name: "Instantiate",
      subtypes: [],
      props: {}
    },
    InsufficientStake: {
      name: "InsufficientStake",
      subtypes: [],
      props: {
        account_id: "",
        minimum_stake: "",
        stake: ""
      }
    },
    IntegerOverflow: {
      name: "IntegerOverflow",
      subtypes: [],
      props: {}
    },
    InternalMemoryDeclared: {
      name: "InternalMemoryDeclared",
      subtypes: [],
      props: {}
    },
    InvalidAccessKeyError: {
      name: "InvalidAccessKeyError",
      subtypes: [
        "AccessKeyNotFound",
        "ReceiverMismatch",
        "MethodNameMismatch",
        "RequiresFullAccess",
        "NotEnoughAllowance",
        "DepositWithFunctionCall"
      ],
      props: {}
    },
    InvalidAccountId: {
      name: "InvalidAccountId",
      subtypes: [],
      props: {}
    },
    InvalidChain: {
      name: "InvalidChain",
      subtypes: [],
      props: {}
    },
    InvalidDataReceiverId: {
      name: "InvalidDataReceiverId",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    InvalidIteratorIndex: {
      name: "InvalidIteratorIndex",
      subtypes: [],
      props: {
        iterator_index: ""
      }
    },
    InvalidMethodName: {
      name: "InvalidMethodName",
      subtypes: [],
      props: {}
    },
    InvalidNonce: {
      name: "InvalidNonce",
      subtypes: [],
      props: {
        ak_nonce: "",
        tx_nonce: ""
      }
    },
    InvalidPredecessorId: {
      name: "InvalidPredecessorId",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    InvalidPromiseIndex: {
      name: "InvalidPromiseIndex",
      subtypes: [],
      props: {
        promise_idx: ""
      }
    },
    InvalidPromiseResultIndex: {
      name: "InvalidPromiseResultIndex",
      subtypes: [],
      props: {
        result_idx: ""
      }
    },
    InvalidPublicKey: {
      name: "InvalidPublicKey",
      subtypes: [],
      props: {}
    },
    InvalidReceiptIndex: {
      name: "InvalidReceiptIndex",
      subtypes: [],
      props: {
        receipt_index: ""
      }
    },
    InvalidReceiverId: {
      name: "InvalidReceiverId",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    InvalidRegisterId: {
      name: "InvalidRegisterId",
      subtypes: [],
      props: {
        register_id: ""
      }
    },
    InvalidSignature: {
      name: "InvalidSignature",
      subtypes: [],
      props: {}
    },
    InvalidSignerId: {
      name: "InvalidSignerId",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    InvalidTxError: {
      name: "InvalidTxError",
      subtypes: [
        "InvalidAccessKeyError",
        "InvalidSignerId",
        "SignerDoesNotExist",
        "InvalidNonce",
        "NonceTooLarge",
        "InvalidReceiverId",
        "InvalidSignature",
        "NotEnoughBalance",
        "LackBalanceForState",
        "CostOverflow",
        "InvalidChain",
        "Expired",
        "ActionsValidation",
        "TransactionSizeExceeded",
        "StorageError",
        "ShardCongested",
        "ShardStuck"
      ],
      props: {}
    },
    IteratorWasInvalidated: {
      name: "IteratorWasInvalidated",
      subtypes: [],
      props: {
        iterator_index: ""
      }
    },
    KeyLengthExceeded: {
      name: "KeyLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    LackBalanceForState: {
      name: "LackBalanceForState",
      subtypes: [],
      props: {
        account_id: "",
        amount: ""
      }
    },
    Memory: {
      name: "Memory",
      subtypes: [],
      props: {}
    },
    MemoryAccessViolation: {
      name: "MemoryAccessViolation",
      subtypes: [],
      props: {}
    },
    MemoryOutOfBounds: {
      name: "MemoryOutOfBounds",
      subtypes: [],
      props: {}
    },
    MethodEmptyName: {
      name: "MethodEmptyName",
      subtypes: [],
      props: {}
    },
    MethodInvalidSignature: {
      name: "MethodInvalidSignature",
      subtypes: [],
      props: {}
    },
    MethodNameMismatch: {
      name: "MethodNameMismatch",
      subtypes: [],
      props: {
        method_name: ""
      }
    },
    MethodNotFound: {
      name: "MethodNotFound",
      subtypes: [],
      props: {}
    },
    MethodResolveError: {
      name: "MethodResolveError",
      subtypes: [
        "MethodEmptyName",
        "MethodNotFound",
        "MethodInvalidSignature"
      ],
      props: {}
    },
    MisalignedAtomicAccess: {
      name: "MisalignedAtomicAccess",
      subtypes: [],
      props: {}
    },
    NonceTooLarge: {
      name: "NonceTooLarge",
      subtypes: [],
      props: {
        tx_nonce: "",
        upper_bound: ""
      }
    },
    NotEnoughAllowance: {
      name: "NotEnoughAllowance",
      subtypes: [],
      props: {
        account_id: "",
        allowance: "",
        cost: "",
        public_key: ""
      }
    },
    NotEnoughBalance: {
      name: "NotEnoughBalance",
      subtypes: [],
      props: {
        balance: "",
        cost: "",
        signer_id: ""
      }
    },
    NumberInputDataDependenciesExceeded: {
      name: "NumberInputDataDependenciesExceeded",
      subtypes: [],
      props: {
        limit: "",
        number_of_input_data_dependencies: ""
      }
    },
    NumberOfLogsExceeded: {
      name: "NumberOfLogsExceeded",
      subtypes: [],
      props: {
        limit: ""
      }
    },
    NumberPromisesExceeded: {
      name: "NumberPromisesExceeded",
      subtypes: [],
      props: {
        limit: "",
        number_of_promises: ""
      }
    },
    OnlyImplicitAccountCreationAllowed: {
      name: "OnlyImplicitAccountCreationAllowed",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    PrepareError: {
      name: "PrepareError",
      subtypes: [
        "Serialization",
        "Deserialization",
        "InternalMemoryDeclared",
        "GasInstrumentation",
        "StackHeightInstrumentation",
        "Instantiate",
        "Memory",
        "TooManyFunctions",
        "TooManyLocals"
      ],
      props: {}
    },
    ProhibitedInView: {
      name: "ProhibitedInView",
      subtypes: [],
      props: {
        method_name: ""
      }
    },
    ReceiptSizeExceeded: {
      name: "ReceiptSizeExceeded",
      subtypes: [],
      props: {
        limit: "",
        size: ""
      }
    },
    ReceiptValidationError: {
      name: "ReceiptValidationError",
      subtypes: [
        "InvalidPredecessorId",
        "InvalidReceiverId",
        "InvalidSignerId",
        "InvalidDataReceiverId",
        "ReturnedValueLengthExceeded",
        "NumberInputDataDependenciesExceeded",
        "ActionsValidation",
        "ReceiptSizeExceeded"
      ],
      props: {}
    },
    ReceiverMismatch: {
      name: "ReceiverMismatch",
      subtypes: [],
      props: {
        ak_receiver: "",
        tx_receiver: ""
      }
    },
    RequiresFullAccess: {
      name: "RequiresFullAccess",
      subtypes: [],
      props: {}
    },
    ReturnedValueLengthExceeded: {
      name: "ReturnedValueLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    Serialization: {
      name: "Serialization",
      subtypes: [],
      props: {}
    },
    ShardCongested: {
      name: "ShardCongested",
      subtypes: [],
      props: {
        congestion_level: "",
        shard_id: ""
      }
    },
    ShardStuck: {
      name: "ShardStuck",
      subtypes: [],
      props: {
        missed_chunks: "",
        shard_id: ""
      }
    },
    SignerDoesNotExist: {
      name: "SignerDoesNotExist",
      subtypes: [],
      props: {
        signer_id: ""
      }
    },
    StackHeightInstrumentation: {
      name: "StackHeightInstrumentation",
      subtypes: [],
      props: {}
    },
    StackOverflow: {
      name: "StackOverflow",
      subtypes: [],
      props: {}
    },
    TooManyFunctions: {
      name: "TooManyFunctions",
      subtypes: [],
      props: {}
    },
    TooManyLocals: {
      name: "TooManyLocals",
      subtypes: [],
      props: {}
    },
    TotalLogLengthExceeded: {
      name: "TotalLogLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    TotalNumberOfActionsExceeded: {
      name: "TotalNumberOfActionsExceeded",
      subtypes: [],
      props: {
        limit: "",
        total_number_of_actions: ""
      }
    },
    TotalPrepaidGasExceeded: {
      name: "TotalPrepaidGasExceeded",
      subtypes: [],
      props: {
        limit: "",
        total_prepaid_gas: ""
      }
    },
    TransactionSizeExceeded: {
      name: "TransactionSizeExceeded",
      subtypes: [],
      props: {
        limit: "",
        size: ""
      }
    },
    TriesToStake: {
      name: "TriesToStake",
      subtypes: [],
      props: {
        account_id: "",
        balance: "",
        locked: "",
        stake: ""
      }
    },
    TriesToUnstake: {
      name: "TriesToUnstake",
      subtypes: [],
      props: {
        account_id: ""
      }
    },
    TxExecutionError: {
      name: "TxExecutionError",
      subtypes: [
        "ActionError",
        "InvalidTxError"
      ],
      props: {}
    },
    Unreachable: {
      name: "Unreachable",
      subtypes: [],
      props: {}
    },
    UnsuitableStakingKey: {
      name: "UnsuitableStakingKey",
      subtypes: [],
      props: {
        public_key: ""
      }
    },
    UnsupportedProtocolFeature: {
      name: "UnsupportedProtocolFeature",
      subtypes: [],
      props: {
        protocol_feature: "",
        version: ""
      }
    },
    ValueLengthExceeded: {
      name: "ValueLengthExceeded",
      subtypes: [],
      props: {
        length: "",
        limit: ""
      }
    },
    WasmTrap: {
      name: "WasmTrap",
      subtypes: [
        "Unreachable",
        "IncorrectCallIndirectSignature",
        "MemoryOutOfBounds",
        "CallIndirectOOB",
        "IllegalArithmetic",
        "MisalignedAtomicAccess",
        "IndirectCallToNull",
        "StackOverflow",
        "GenericTrap"
      ],
      props: {}
    },
    WasmerCompileError: {
      name: "WasmerCompileError",
      subtypes: [],
      props: {
        msg: ""
      }
    },
    Closed: {
      name: "Closed",
      subtypes: [],
      props: {}
    },
    ServerError: {
      name: "ServerError",
      subtypes: [
        "TxExecutionError",
        "Timeout",
        "Closed"
      ],
      props: {}
    },
    Timeout: {
      name: "Timeout",
      subtypes: [],
      props: {}
    }
  }
};

// src/errors/rpc_errors.ts
var mustacheHelpers = {
  formatNear: () => (n, render) => formatNearAmount(render(n))
};
var ServerError = class extends TypedError {
};
var ServerTransactionError = class extends ServerError {
  transaction_outcome;
};
function parseRpcError(errorObj) {
  const result = {};
  const errorClassName = walkSubtype(errorObj, rpc_error_schema_default.schema, result, "");
  const error = new ServerError(formatError(errorClassName, result), errorClassName);
  Object.assign(error, result);
  return error;
}
function parseResultError(result) {
  const server_error = parseRpcError(result.status.Failure);
  const server_tx_error = new ServerTransactionError();
  Object.assign(server_tx_error, server_error);
  server_tx_error.type = server_error.type;
  server_tx_error.message = server_error.message;
  server_tx_error.transaction_outcome = result.transaction_outcome;
  return server_tx_error;
}
function formatError(errorClassName, errorData) {
  if (typeof ErrorMessages[errorClassName] === "string") {
    return Mustache.render(ErrorMessages[errorClassName], {
      ...errorData,
      ...mustacheHelpers
    });
  }
  return JSON.stringify(errorData);
}
function walkSubtype(errorObj, schema, result, typeName) {
  let error;
  let type;
  let errorTypeName;
  for (const errorName in schema) {
    if (isString(errorObj[errorName])) {
      return errorObj[errorName];
    }
    if (isObject(errorObj[errorName])) {
      error = errorObj[errorName];
      type = schema[errorName];
      errorTypeName = errorName;
    } else if (isObject(errorObj.kind) && isObject(errorObj.kind[errorName])) {
      error = errorObj.kind[errorName];
      type = schema[errorName];
      errorTypeName = errorName;
    } else {
      continue;
    }
  }
  if (error && type) {
    for (const prop of Object.keys(type.props)) {
      result[prop] = error[prop];
    }
    return walkSubtype(error, schema, result, errorTypeName);
  } else {
    result.kind = errorObj;
    return typeName;
  }
}
function getErrorTypeFromErrorMessage(errorMessage, errorType) {
  switch (true) {
    case /^account .*? does not exist while viewing$/.test(errorMessage):
      return "AccountDoesNotExist";
    case /^Account .*? doesn't exist$/.test(errorMessage):
      return "AccountDoesNotExist";
    case /^access key .*? does not exist while viewing$/.test(errorMessage):
      return "AccessKeyDoesNotExist";
    case /wasm execution failed with error: FunctionCallError\(CompilationError\(CodeDoesNotExist/.test(errorMessage):
      return "CodeDoesNotExist";
    case /wasm execution failed with error: CompilationError\(CodeDoesNotExist/.test(errorMessage):
      return "CodeDoesNotExist";
    case /wasm execution failed with error: FunctionCallError\(MethodResolveError\(MethodNotFound/.test(errorMessage):
      return "MethodNotFound";
    case /wasm execution failed with error: MethodResolveError\(MethodNotFound/.test(errorMessage):
      return "MethodNotFound";
    case /Transaction nonce \d+ must be larger than nonce of the used access key \d+/.test(errorMessage):
      return "InvalidNonce";
    default:
      return errorType;
  }
}
function isObject(n) {
  return Object.prototype.toString.call(n) === "[object Object]";
}
function isString(n) {
  return Object.prototype.toString.call(n) === "[object String]";
}
export {
  ServerError,
  formatError,
  getErrorTypeFromErrorMessage,
  parseResultError,
  parseRpcError
};

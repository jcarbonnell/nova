// src/errors/error_messages.json
var GasLimitExceeded = "Exceeded the maximum amount of gas allowed to burn per contract";
var MethodEmptyName = "Method name is empty";
var WasmerCompileError = "Wasmer compilation error: {{msg}}";
var GuestPanic = "Smart contract panicked: {{panic_msg}}";
var Memory = "Error creating Wasm memory";
var GasExceeded = "Exceeded the prepaid gas";
var MethodUTF8Error = "Method name is not valid UTF8 string";
var BadUTF16 = "String encoding is bad UTF-16 sequence";
var WasmTrap = "WebAssembly trap: {{msg}}";
var GasInstrumentation = "Gas instrumentation failed or contract has denied instructions.";
var InvalidPromiseIndex = "{{promise_idx}} does not correspond to existing promises";
var InvalidPromiseResultIndex = "Accessed invalid promise result index: {{result_idx}}";
var Deserialization = "Error happened while deserializing the module";
var MethodNotFound = "Contract method is not found";
var InvalidRegisterId = "Accessed invalid register id: {{register_id}}";
var InvalidReceiptIndex = "VM Logic returned an invalid receipt index: {{receipt_index}}";
var EmptyMethodName = "Method name is empty in contract call";
var CannotReturnJointPromise = "Returning joint promise is currently prohibited";
var StackHeightInstrumentation = "Stack instrumentation failed";
var CodeDoesNotExist = "Cannot find contract code for account {{account_id}}";
var MethodInvalidSignature = "Invalid method signature";
var IntegerOverflow = "Integer overflow happened during contract execution";
var MemoryAccessViolation = "MemoryAccessViolation";
var InvalidIteratorIndex = "Iterator index {{iterator_index}} does not exist";
var IteratorWasInvalidated = "Iterator {{iterator_index}} was invalidated after its creation by performing a mutable operation on trie";
var InvalidAccountId = "VM Logic returned an invalid account id";
var Serialization = "Error happened while serializing the module";
var CannotAppendActionToJointPromise = "Actions can only be appended to non-joint promise.";
var InternalMemoryDeclared = "Internal memory declaration has been found in the module";
var Instantiate = "Error happened during instantiation";
var ProhibitedInView = "{{method_name}} is not allowed in view calls";
var InvalidMethodName = "VM Logic returned an invalid method name";
var BadUTF8 = "String encoding is bad UTF-8 sequence";
var BalanceExceeded = "Exceeded the account balance";
var LinkError = "Wasm contract link error: {{msg}}";
var InvalidPublicKey = "VM Logic provided an invalid public key";
var ActorNoPermission = "Actor {{actor_id}} doesn't have permission to account {{account_id}} to complete the action";
var LackBalanceForState = "The account {{account_id}} wouldn't have enough balance to cover storage, required to have {{amount}} yoctoNEAR more";
var ReceiverMismatch = "Wrong AccessKey used for transaction: transaction is sent to receiver_id={{tx_receiver}}, but is signed with function call access key that restricted to only use with receiver_id={{ak_receiver}}. Either change receiver_id in your transaction or switch to use a FullAccessKey.";
var CostOverflow = "Transaction gas or balance cost is too high";
var InvalidSignature = "Transaction is not signed with the given public key";
var AccessKeyNotFound = `Signer "{{account_id}}" doesn't have access key with the given public_key {{public_key}}`;
var NotEnoughBalance = "Sender {{signer_id}} does not have enough balance {{#formatNear}}{{balance}}{{/formatNear}} for operation costing {{#formatNear}}{{cost}}{{/formatNear}}";
var NotEnoughAllowance = "Access Key {account_id}:{public_key} does not have enough balance {{#formatNear}}{{allowance}}{{/formatNear}} for transaction costing {{#formatNear}}{{cost}}{{/formatNear}}";
var Expired = "Transaction has expired";
var DeleteAccountStaking = "Account {{account_id}} is staking and can not be deleted";
var SignerDoesNotExist = "Signer {{signer_id}} does not exist";
var TriesToStake = "Account {{account_id}} tried to stake {{#formatNear}}{{stake}}{{/formatNear}}, but has staked {{#formatNear}}{{locked}}{{/formatNear}} and only has {{#formatNear}}{{balance}}{{/formatNear}}";
var AddKeyAlreadyExists = "The public key {{public_key}} is already used for an existing access key";
var InvalidSigner = "Invalid signer account ID {{signer_id}} according to requirements";
var CreateAccountNotAllowed = "The new account_id {{account_id}} can't be created by {{predecessor_id}}";
var RequiresFullAccess = "The transaction contains more then one action, but it was signed with an access key which allows transaction to apply only one specific action. To apply more then one actions TX must be signed with a full access key";
var TriesToUnstake = "Account {{account_id}} is not yet staked, but tried to unstake";
var InvalidNonce = "Transaction nonce {{tx_nonce}} must be larger than nonce of the used access key {{ak_nonce}}";
var AccountAlreadyExists = "Can't create a new account {{account_id}}, because it already exists";
var InvalidChain = "Transaction parent block hash doesn't belong to the current chain";
var AccountDoesNotExist = "Can't complete the action because account {{account_id}} doesn't exist";
var AccessKeyDoesNotExist = "Can't complete the action because access key {{public_key}} doesn't exist";
var MethodNameMismatch = "Transaction method name {{method_name}} isn't allowed by the access key";
var DeleteAccountHasRent = "Account {{account_id}} can't be deleted. It has {{#formatNear}}{{balance}}{{/formatNear}}, which is enough to cover the rent";
var DeleteAccountHasEnoughBalance = "Account {{account_id}} can't be deleted. It has {{#formatNear}}{{balance}}{{/formatNear}}, which is enough to cover it's storage";
var InvalidReceiver = "Invalid receiver account ID {{receiver_id}} according to requirements";
var DeleteKeyDoesNotExist = "Account {{account_id}} tries to remove an access key that doesn't exist";
var Timeout = "Timeout exceeded";
var Closed = "Connection closed";
var ShardCongested = "Shard {{shard_id}} rejected the transaction due to congestion level {{congestion_level}}, try again later";
var ShardStuck = "Shard {{shard_id}} rejected the transaction because it missed {{missed_chunks}} chunks and needs to recover before accepting new transactions, try again later";
var error_messages_default = {
  GasLimitExceeded,
  MethodEmptyName,
  WasmerCompileError,
  GuestPanic,
  Memory,
  GasExceeded,
  MethodUTF8Error,
  BadUTF16,
  WasmTrap,
  GasInstrumentation,
  InvalidPromiseIndex,
  InvalidPromiseResultIndex,
  Deserialization,
  MethodNotFound,
  InvalidRegisterId,
  InvalidReceiptIndex,
  EmptyMethodName,
  CannotReturnJointPromise,
  StackHeightInstrumentation,
  CodeDoesNotExist,
  MethodInvalidSignature,
  IntegerOverflow,
  MemoryAccessViolation,
  InvalidIteratorIndex,
  IteratorWasInvalidated,
  InvalidAccountId,
  Serialization,
  CannotAppendActionToJointPromise,
  InternalMemoryDeclared,
  Instantiate,
  ProhibitedInView,
  InvalidMethodName,
  BadUTF8,
  BalanceExceeded,
  LinkError,
  InvalidPublicKey,
  ActorNoPermission,
  LackBalanceForState,
  ReceiverMismatch,
  CostOverflow,
  InvalidSignature,
  AccessKeyNotFound,
  NotEnoughBalance,
  NotEnoughAllowance,
  Expired,
  DeleteAccountStaking,
  SignerDoesNotExist,
  TriesToStake,
  AddKeyAlreadyExists,
  InvalidSigner,
  CreateAccountNotAllowed,
  RequiresFullAccess,
  TriesToUnstake,
  InvalidNonce,
  AccountAlreadyExists,
  InvalidChain,
  AccountDoesNotExist,
  AccessKeyDoesNotExist,
  MethodNameMismatch,
  DeleteAccountHasRent,
  DeleteAccountHasEnoughBalance,
  InvalidReceiver,
  DeleteKeyDoesNotExist,
  Timeout,
  Closed,
  ShardCongested,
  ShardStuck
};
export {
  AccessKeyDoesNotExist,
  AccessKeyNotFound,
  AccountAlreadyExists,
  AccountDoesNotExist,
  ActorNoPermission,
  AddKeyAlreadyExists,
  BadUTF16,
  BadUTF8,
  BalanceExceeded,
  CannotAppendActionToJointPromise,
  CannotReturnJointPromise,
  Closed,
  CodeDoesNotExist,
  CostOverflow,
  CreateAccountNotAllowed,
  DeleteAccountHasEnoughBalance,
  DeleteAccountHasRent,
  DeleteAccountStaking,
  DeleteKeyDoesNotExist,
  Deserialization,
  EmptyMethodName,
  Expired,
  GasExceeded,
  GasInstrumentation,
  GasLimitExceeded,
  GuestPanic,
  Instantiate,
  IntegerOverflow,
  InternalMemoryDeclared,
  InvalidAccountId,
  InvalidChain,
  InvalidIteratorIndex,
  InvalidMethodName,
  InvalidNonce,
  InvalidPromiseIndex,
  InvalidPromiseResultIndex,
  InvalidPublicKey,
  InvalidReceiptIndex,
  InvalidReceiver,
  InvalidRegisterId,
  InvalidSignature,
  InvalidSigner,
  IteratorWasInvalidated,
  LackBalanceForState,
  LinkError,
  Memory,
  MemoryAccessViolation,
  MethodEmptyName,
  MethodInvalidSignature,
  MethodNameMismatch,
  MethodNotFound,
  MethodUTF8Error,
  NotEnoughAllowance,
  NotEnoughBalance,
  ProhibitedInView,
  ReceiverMismatch,
  RequiresFullAccess,
  Serialization,
  ShardCongested,
  ShardStuck,
  SignerDoesNotExist,
  StackHeightInstrumentation,
  Timeout,
  TriesToStake,
  TriesToUnstake,
  WasmTrap,
  WasmerCompileError,
  error_messages_default as default
};

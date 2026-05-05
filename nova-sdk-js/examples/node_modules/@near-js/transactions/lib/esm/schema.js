import { deserialize, serialize } from "borsh";
import { DelegateActionPrefix } from "./prefix.js";
function encodeDelegateAction(delegateAction) {
  return new Uint8Array([
    ...serialize(SCHEMA.DelegateActionPrefix, new DelegateActionPrefix()),
    ...serialize(SCHEMA.DelegateAction, delegateAction)
  ]);
}
function encodeSignedDelegate(signedDelegate) {
  return serialize(SCHEMA.SignedDelegate, signedDelegate);
}
function encodeTransaction(transaction) {
  const schema = "signature" in transaction ? SCHEMA.SignedTransaction : SCHEMA.Transaction;
  return serialize(schema, transaction);
}
function decodeTransaction(bytes) {
  return new Transaction(deserialize(SCHEMA.Transaction, bytes));
}
function decodeSignedTransaction(bytes) {
  return new SignedTransaction(deserialize(SCHEMA.SignedTransaction, bytes));
}
class Transaction {
  signerId;
  publicKey;
  nonce;
  receiverId;
  actions;
  blockHash;
  constructor({ signerId, publicKey, nonce, receiverId, actions, blockHash }) {
    this.signerId = signerId;
    this.publicKey = publicKey;
    this.nonce = nonce;
    this.receiverId = receiverId;
    this.actions = actions;
    this.blockHash = blockHash;
  }
  encode() {
    return encodeTransaction(this);
  }
  static decode(bytes) {
    return decodeTransaction(bytes);
  }
}
class SignedTransaction {
  transaction;
  signature;
  constructor({ transaction, signature }) {
    this.transaction = transaction;
    this.signature = signature;
  }
  encode() {
    return encodeTransaction(this);
  }
  static decode(bytes) {
    return decodeSignedTransaction(bytes);
  }
}
const SCHEMA = new class BorshSchema {
  Ed25519Signature = {
    struct: {
      data: { array: { type: "u8", len: 64 } }
    }
  };
  Secp256k1Signature = {
    struct: {
      data: { array: { type: "u8", len: 65 } }
    }
  };
  Signature = {
    enum: [
      { struct: { ed25519Signature: this.Ed25519Signature } },
      { struct: { secp256k1Signature: this.Secp256k1Signature } }
    ]
  };
  Ed25519Data = {
    struct: {
      data: { array: { type: "u8", len: 32 } }
    }
  };
  Secp256k1Data = {
    struct: {
      data: { array: { type: "u8", len: 64 } }
    }
  };
  PublicKey = {
    enum: [
      { struct: { ed25519Key: this.Ed25519Data } },
      { struct: { secp256k1Key: this.Secp256k1Data } }
    ]
  };
  FunctionCallPermission = {
    struct: {
      allowance: { option: "u128" },
      receiverId: "string",
      methodNames: { array: { type: "string" } }
    }
  };
  FullAccessPermission = {
    struct: {}
  };
  AccessKeyPermission = {
    enum: [
      { struct: { functionCall: this.FunctionCallPermission } },
      { struct: { fullAccess: this.FullAccessPermission } }
    ]
  };
  AccessKey = {
    struct: {
      nonce: "u64",
      permission: this.AccessKeyPermission
    }
  };
  CreateAccount = {
    struct: {}
  };
  DeployContract = {
    struct: {
      code: { array: { type: "u8" } }
    }
  };
  FunctionCall = {
    struct: {
      methodName: "string",
      args: { array: { type: "u8" } },
      gas: "u64",
      deposit: "u128"
    }
  };
  Transfer = {
    struct: {
      deposit: "u128"
    }
  };
  Stake = {
    struct: {
      stake: "u128",
      publicKey: this.PublicKey
    }
  };
  AddKey = {
    struct: {
      publicKey: this.PublicKey,
      accessKey: this.AccessKey
    }
  };
  DeleteKey = {
    struct: {
      publicKey: this.PublicKey
    }
  };
  DeleteAccount = {
    struct: {
      beneficiaryId: "string"
    }
  };
  GlobalContractDeployMode = {
    enum: [
      { struct: { CodeHash: { struct: {} } } },
      { struct: { AccountId: { struct: {} } } }
    ]
  };
  GlobalContractIdentifier = {
    enum: [
      { struct: { CodeHash: { array: { type: "u8", len: 32 } } } },
      { struct: { AccountId: "string" } }
    ]
  };
  DeployGlobalContract = {
    struct: {
      code: { array: { type: "u8" } },
      deployMode: this.GlobalContractDeployMode
    }
  };
  UseGlobalContract = {
    struct: {
      contractIdentifier: this.GlobalContractIdentifier
    }
  };
  DelegateActionPrefix = {
    struct: {
      prefix: "u32"
    }
  };
  /** @todo: get rid of "ClassicActions" and keep only "Action" schema to be consistent with "nearcore" */
  ClassicActions = {
    enum: [
      { struct: { createAccount: this.CreateAccount } },
      { struct: { deployContract: this.DeployContract } },
      { struct: { functionCall: this.FunctionCall } },
      { struct: { transfer: this.Transfer } },
      { struct: { stake: this.Stake } },
      { struct: { addKey: this.AddKey } },
      { struct: { deleteKey: this.DeleteKey } },
      { struct: { deleteAccount: this.DeleteAccount } },
      { struct: { signedDelegate: "string" } },
      // placeholder to keep the right enum order, should not be used 
      { struct: { deployGlobalContract: this.DeployGlobalContract } },
      { struct: { useGlobalContract: this.UseGlobalContract } }
    ]
  };
  DelegateAction = {
    struct: {
      senderId: "string",
      receiverId: "string",
      actions: { array: { type: this.ClassicActions } },
      nonce: "u64",
      maxBlockHeight: "u64",
      publicKey: this.PublicKey
    }
  };
  SignedDelegate = {
    struct: {
      delegateAction: this.DelegateAction,
      signature: this.Signature
    }
  };
  Action = {
    enum: [
      { struct: { createAccount: this.CreateAccount } },
      { struct: { deployContract: this.DeployContract } },
      { struct: { functionCall: this.FunctionCall } },
      { struct: { transfer: this.Transfer } },
      { struct: { stake: this.Stake } },
      { struct: { addKey: this.AddKey } },
      { struct: { deleteKey: this.DeleteKey } },
      { struct: { deleteAccount: this.DeleteAccount } },
      { struct: { signedDelegate: this.SignedDelegate } },
      { struct: { deployGlobalContract: this.DeployGlobalContract } },
      { struct: { useGlobalContract: this.UseGlobalContract } }
    ]
  };
  Transaction = {
    struct: {
      signerId: "string",
      publicKey: this.PublicKey,
      nonce: "u64",
      receiverId: "string",
      blockHash: { array: { type: "u8", len: 32 } },
      actions: { array: { type: this.Action } }
    }
  };
  SignedTransaction = {
    struct: {
      transaction: this.Transaction,
      signature: this.Signature
    }
  };
}();
export {
  SCHEMA,
  SignedTransaction,
  Transaction,
  decodeSignedTransaction,
  decodeTransaction,
  encodeDelegateAction,
  encodeSignedDelegate,
  encodeTransaction
};

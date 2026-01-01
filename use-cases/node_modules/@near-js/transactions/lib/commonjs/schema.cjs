"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var schema_exports = {};
__export(schema_exports, {
  SCHEMA: () => SCHEMA,
  SignedTransaction: () => SignedTransaction,
  Transaction: () => Transaction,
  decodeSignedTransaction: () => decodeSignedTransaction,
  decodeTransaction: () => decodeTransaction,
  encodeDelegateAction: () => encodeDelegateAction,
  encodeSignedDelegate: () => encodeSignedDelegate,
  encodeTransaction: () => encodeTransaction
});
module.exports = __toCommonJS(schema_exports);
var import_borsh = require("borsh");
var import_prefix = require('./prefix.cjs');
function encodeDelegateAction(delegateAction) {
  return new Uint8Array([
    ...(0, import_borsh.serialize)(SCHEMA.DelegateActionPrefix, new import_prefix.DelegateActionPrefix()),
    ...(0, import_borsh.serialize)(SCHEMA.DelegateAction, delegateAction)
  ]);
}
function encodeSignedDelegate(signedDelegate) {
  return (0, import_borsh.serialize)(SCHEMA.SignedDelegate, signedDelegate);
}
function encodeTransaction(transaction) {
  const schema = "signature" in transaction ? SCHEMA.SignedTransaction : SCHEMA.Transaction;
  return (0, import_borsh.serialize)(schema, transaction);
}
function decodeTransaction(bytes) {
  return new Transaction((0, import_borsh.deserialize)(SCHEMA.Transaction, bytes));
}
function decodeSignedTransaction(bytes) {
  return new SignedTransaction((0, import_borsh.deserialize)(SCHEMA.SignedTransaction, bytes));
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SCHEMA,
  SignedTransaction,
  Transaction,
  decodeSignedTransaction,
  decodeTransaction,
  encodeDelegateAction,
  encodeSignedDelegate,
  encodeTransaction
});

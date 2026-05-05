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
var actions_exports = {};
__export(actions_exports, {
  AccessKey: () => AccessKey,
  AccessKeyPermission: () => AccessKeyPermission,
  Action: () => Action,
  AddKey: () => AddKey,
  CreateAccount: () => CreateAccount,
  DeleteAccount: () => DeleteAccount,
  DeleteKey: () => DeleteKey,
  DeployContract: () => DeployContract,
  DeployGlobalContract: () => DeployGlobalContract,
  FullAccessPermission: () => FullAccessPermission,
  FunctionCall: () => FunctionCall,
  FunctionCallPermission: () => FunctionCallPermission,
  GlobalContractDeployMode: () => GlobalContractDeployMode,
  GlobalContractIdentifier: () => GlobalContractIdentifier,
  SignedDelegate: () => SignedDelegate,
  Stake: () => Stake,
  Transfer: () => Transfer,
  UseGlobalContract: () => UseGlobalContract
});
module.exports = __toCommonJS(actions_exports);
var import_types = require("@near-js/types");
class FunctionCallPermission {
  allowance;
  receiverId;
  methodNames;
  constructor({ allowance, receiverId, methodNames }) {
    this.allowance = allowance;
    this.receiverId = receiverId;
    this.methodNames = methodNames;
  }
}
class FullAccessPermission {
}
class AccessKeyPermission extends import_types.Enum {
  enum;
  functionCall;
  fullAccess;
  constructor(props) {
    super(props);
    for (const [k, v] of Object.entries(props || {})) {
      this[k] = v;
      this.enum = k;
    }
  }
}
class AccessKey {
  nonce;
  permission;
  constructor({ nonce, permission }) {
    this.nonce = nonce;
    this.permission = permission;
  }
}
class CreateAccount {
}
class DeployContract {
  code;
  constructor({ code }) {
    this.code = code;
  }
}
class FunctionCall {
  methodName;
  args;
  gas;
  deposit;
  constructor({ methodName, args, gas, deposit }) {
    this.methodName = methodName;
    this.args = args;
    this.gas = gas;
    this.deposit = deposit;
  }
}
class GlobalContractDeployMode extends import_types.Enum {
  enum;
  CodeHash;
  AccountId;
  constructor(props) {
    super(props);
    for (const [k, v] of Object.entries(props || {})) {
      this[k] = v;
      this.enum = k;
    }
  }
}
class GlobalContractIdentifier extends import_types.Enum {
  enum;
  CodeHash;
  AccountId;
  constructor(props) {
    super(props);
    for (const [k, v] of Object.entries(props || {})) {
      this[k] = v;
      this.enum = k;
    }
  }
}
class DeployGlobalContract {
  code;
  deployMode;
  constructor({ code, deployMode }) {
    this.code = code;
    this.deployMode = deployMode;
  }
}
class UseGlobalContract {
  contractIdentifier;
  constructor({ contractIdentifier }) {
    this.contractIdentifier = contractIdentifier;
  }
}
class Transfer {
  deposit;
  constructor({ deposit }) {
    this.deposit = deposit;
  }
}
class Stake {
  stake;
  publicKey;
  constructor({ stake, publicKey }) {
    this.stake = stake;
    this.publicKey = publicKey;
  }
}
class AddKey {
  publicKey;
  accessKey;
  constructor({ publicKey, accessKey }) {
    this.publicKey = publicKey;
    this.accessKey = accessKey;
  }
}
class DeleteKey {
  publicKey;
  constructor({ publicKey }) {
    this.publicKey = publicKey;
  }
}
class DeleteAccount {
  beneficiaryId;
  constructor({ beneficiaryId }) {
    this.beneficiaryId = beneficiaryId;
  }
}
class SignedDelegate {
  delegateAction;
  signature;
  constructor({ delegateAction, signature }) {
    this.delegateAction = delegateAction;
    this.signature = signature;
  }
}
class Action extends import_types.Enum {
  enum;
  createAccount;
  deployContract;
  functionCall;
  transfer;
  stake;
  addKey;
  deleteKey;
  deleteAccount;
  signedDelegate;
  deployGlobalContract;
  useGlobalContract;
  constructor(props) {
    super(props);
    for (const [k, v] of Object.entries(props || {})) {
      this[k] = v;
      this.enum = k;
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AccessKey,
  AccessKeyPermission,
  Action,
  AddKey,
  CreateAccount,
  DeleteAccount,
  DeleteKey,
  DeployContract,
  DeployGlobalContract,
  FullAccessPermission,
  FunctionCall,
  FunctionCallPermission,
  GlobalContractDeployMode,
  GlobalContractIdentifier,
  SignedDelegate,
  Stake,
  Transfer,
  UseGlobalContract
});

import { Enum } from "@near-js/types";
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
class AccessKeyPermission extends Enum {
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
class GlobalContractDeployMode extends Enum {
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
class GlobalContractIdentifier extends Enum {
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
class Action extends Enum {
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
export {
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
};

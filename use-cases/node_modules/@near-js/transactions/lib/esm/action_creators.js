import {
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
  SignedDelegate,
  Stake,
  Transfer,
  UseGlobalContract
} from "./actions.js";
function fullAccessKey() {
  return new AccessKey({
    nonce: 0n,
    permission: new AccessKeyPermission({
      fullAccess: new FullAccessPermission()
    })
  });
}
function functionCallAccessKey(receiverId, methodNames, allowance) {
  return new AccessKey({
    nonce: 0n,
    permission: new AccessKeyPermission({
      functionCall: new FunctionCallPermission({
        receiverId,
        allowance,
        methodNames
      })
    })
  });
}
function createAccount() {
  return new Action({ createAccount: new CreateAccount() });
}
function deployContract(code) {
  return new Action({ deployContract: new DeployContract({ code }) });
}
function stringifyJsonOrBytes(args) {
  const isUint8Array = args.byteLength !== void 0 && args.byteLength === args.length;
  return isUint8Array ? args : Buffer.from(JSON.stringify(args));
}
function functionCall(methodName, args, gas = 0n, deposit = 0n, stringify = stringifyJsonOrBytes) {
  return new Action({
    functionCall: new FunctionCall({
      methodName,
      args: stringify(args),
      gas,
      deposit
    })
  });
}
function transfer(deposit = 0n) {
  return new Action({ transfer: new Transfer({ deposit }) });
}
function stake(stake2 = 0n, publicKey) {
  return new Action({ stake: new Stake({ stake: stake2, publicKey }) });
}
function addKey(publicKey, accessKey) {
  return new Action({ addKey: new AddKey({ publicKey, accessKey }) });
}
function deleteKey(publicKey) {
  return new Action({ deleteKey: new DeleteKey({ publicKey }) });
}
function deleteAccount(beneficiaryId) {
  return new Action({ deleteAccount: new DeleteAccount({ beneficiaryId }) });
}
function signedDelegate({
  delegateAction,
  signature
}) {
  return new Action({
    signedDelegate: new SignedDelegate({ delegateAction, signature })
  });
}
function deployGlobalContract(code, deployMode) {
  return new Action({ deployGlobalContract: new DeployGlobalContract({ code, deployMode }) });
}
function useGlobalContract(contractIdentifier) {
  return new Action({ useGlobalContract: new UseGlobalContract({ contractIdentifier }) });
}
const actionCreators = {
  addKey,
  createAccount,
  deleteAccount,
  deleteKey,
  deployContract,
  fullAccessKey,
  functionCall,
  functionCallAccessKey,
  signedDelegate,
  stake,
  transfer,
  deployGlobalContract,
  useGlobalContract
};
export {
  actionCreators,
  stringifyJsonOrBytes
};

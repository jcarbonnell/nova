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
var action_creators_exports = {};
__export(action_creators_exports, {
  actionCreators: () => actionCreators,
  stringifyJsonOrBytes: () => stringifyJsonOrBytes
});
module.exports = __toCommonJS(action_creators_exports);
var import_actions = require('./actions.cjs');
function fullAccessKey() {
  return new import_actions.AccessKey({
    nonce: 0n,
    permission: new import_actions.AccessKeyPermission({
      fullAccess: new import_actions.FullAccessPermission()
    })
  });
}
function functionCallAccessKey(receiverId, methodNames, allowance) {
  return new import_actions.AccessKey({
    nonce: 0n,
    permission: new import_actions.AccessKeyPermission({
      functionCall: new import_actions.FunctionCallPermission({
        receiverId,
        allowance,
        methodNames
      })
    })
  });
}
function createAccount() {
  return new import_actions.Action({ createAccount: new import_actions.CreateAccount() });
}
function deployContract(code) {
  return new import_actions.Action({ deployContract: new import_actions.DeployContract({ code }) });
}
function stringifyJsonOrBytes(args) {
  const isUint8Array = args.byteLength !== void 0 && args.byteLength === args.length;
  return isUint8Array ? args : Buffer.from(JSON.stringify(args));
}
function functionCall(methodName, args, gas = 0n, deposit = 0n, stringify = stringifyJsonOrBytes) {
  return new import_actions.Action({
    functionCall: new import_actions.FunctionCall({
      methodName,
      args: stringify(args),
      gas,
      deposit
    })
  });
}
function transfer(deposit = 0n) {
  return new import_actions.Action({ transfer: new import_actions.Transfer({ deposit }) });
}
function stake(stake2 = 0n, publicKey) {
  return new import_actions.Action({ stake: new import_actions.Stake({ stake: stake2, publicKey }) });
}
function addKey(publicKey, accessKey) {
  return new import_actions.Action({ addKey: new import_actions.AddKey({ publicKey, accessKey }) });
}
function deleteKey(publicKey) {
  return new import_actions.Action({ deleteKey: new import_actions.DeleteKey({ publicKey }) });
}
function deleteAccount(beneficiaryId) {
  return new import_actions.Action({ deleteAccount: new import_actions.DeleteAccount({ beneficiaryId }) });
}
function signedDelegate({
  delegateAction,
  signature
}) {
  return new import_actions.Action({
    signedDelegate: new import_actions.SignedDelegate({ delegateAction, signature })
  });
}
function deployGlobalContract(code, deployMode) {
  return new import_actions.Action({ deployGlobalContract: new import_actions.DeployGlobalContract({ code, deployMode }) });
}
function useGlobalContract(contractIdentifier) {
  return new import_actions.Action({ useGlobalContract: new import_actions.UseGlobalContract({ contractIdentifier }) });
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  actionCreators,
  stringifyJsonOrBytes
});

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
var delegate_exports = {};
__export(delegate_exports, {
  DelegateAction: () => DelegateAction,
  buildDelegateAction: () => buildDelegateAction
});
module.exports = __toCommonJS(delegate_exports);
var import_action_creators = require('./action_creators.cjs');
var import_actions = require('./actions.cjs');
const {
  addKey,
  createAccount,
  deleteAccount,
  deleteKey,
  deployContract,
  functionCall,
  stake,
  transfer,
  deployGlobalContract,
  useGlobalContract
} = import_action_creators.actionCreators;
class DelegateAction {
  senderId;
  receiverId;
  actions;
  nonce;
  maxBlockHeight;
  publicKey;
  constructor({ senderId, receiverId, actions, nonce, maxBlockHeight, publicKey }) {
    this.senderId = senderId;
    this.receiverId = receiverId;
    this.actions = actions;
    this.nonce = nonce;
    this.maxBlockHeight = maxBlockHeight;
    this.publicKey = publicKey;
  }
}
function buildDelegateAction({
  actions,
  maxBlockHeight,
  nonce,
  publicKey,
  receiverId,
  senderId
}) {
  return new DelegateAction({
    senderId,
    receiverId,
    actions: actions.map((a) => {
      if (!a.type && !a.params) {
        return a;
      }
      switch (a.type) {
        case "AddKey": {
          const { publicKey: publicKey2, accessKey } = a.params;
          return addKey(publicKey2, accessKey);
        }
        case "CreateAccount": {
          return createAccount(a.params.createAccount);
        }
        case "DeleteAccount": {
          return deleteAccount(a.params.deleteAccount);
        }
        case "DeleteKey": {
          return deleteKey(a.params.publicKey);
        }
        case "DeployContract": {
          return deployContract(a.params.code);
        }
        case "FunctionCall": {
          const { methodName, args, gas, deposit } = a.params;
          return functionCall(methodName, args, gas, deposit);
        }
        case "Stake": {
          return stake(a.params.stake, a.params.publicKey);
        }
        case "Transfer": {
          const { deposit } = a.params;
          return transfer(deposit);
        }
        case "DeployGlobalContract": {
          const { code, deployMode } = a.params;
          const modeInstance = deployMode instanceof import_actions.GlobalContractDeployMode ? deployMode : new import_actions.GlobalContractDeployMode(deployMode);
          return deployGlobalContract(code, modeInstance);
        }
        case "UseGlobalContract": {
          const { identifier } = a.params;
          const idInstance = identifier instanceof import_actions.GlobalContractIdentifier ? identifier : new import_actions.GlobalContractIdentifier(identifier);
          return useGlobalContract(idInstance);
        }
      }
      throw new Error("Unrecognized action");
    }),
    nonce,
    maxBlockHeight,
    publicKey
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DelegateAction,
  buildDelegateAction
});

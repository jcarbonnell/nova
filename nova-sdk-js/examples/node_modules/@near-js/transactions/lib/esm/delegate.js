import { actionCreators } from "./action_creators.js";
import { GlobalContractDeployMode, GlobalContractIdentifier } from "./actions.js";
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
} = actionCreators;
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
          const modeInstance = deployMode instanceof GlobalContractDeployMode ? deployMode : new GlobalContractDeployMode(deployMode);
          return deployGlobalContract(code, modeInstance);
        }
        case "UseGlobalContract": {
          const { identifier } = a.params;
          const idInstance = identifier instanceof GlobalContractIdentifier ? identifier : new GlobalContractIdentifier(identifier);
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
export {
  DelegateAction,
  buildDelegateAction
};

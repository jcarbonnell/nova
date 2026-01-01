import { parseNearAmount } from "@near-js/utils";
const MULTISIG_STORAGE_KEY = "__multisigRequest";
const MULTISIG_ALLOWANCE = BigInt(parseNearAmount("1"));
const MULTISIG_GAS = 100000000000000n;
const MULTISIG_DEPOSIT = 0n;
const MULTISIG_CHANGE_METHODS = ["add_request", "add_request_and_confirm", "delete_request", "confirm"];
const MULTISIG_CONFIRM_METHODS = ["confirm"];
export {
  MULTISIG_ALLOWANCE,
  MULTISIG_CHANGE_METHODS,
  MULTISIG_CONFIRM_METHODS,
  MULTISIG_DEPOSIT,
  MULTISIG_GAS,
  MULTISIG_STORAGE_KEY
};

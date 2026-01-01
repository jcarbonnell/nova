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
var types_exports = {};
__export(types_exports, {
  MultisigDeleteRequestRejectionError: () => MultisigDeleteRequestRejectionError,
  MultisigStateStatus: () => MultisigStateStatus
});
module.exports = __toCommonJS(types_exports);
var MultisigDeleteRequestRejectionError = /* @__PURE__ */ ((MultisigDeleteRequestRejectionError2) => {
  MultisigDeleteRequestRejectionError2["CANNOT_DESERIALIZE_STATE"] = "Cannot deserialize the contract state";
  MultisigDeleteRequestRejectionError2["MULTISIG_NOT_INITIALIZED"] = "Smart contract panicked: Multisig contract should be initialized before usage";
  MultisigDeleteRequestRejectionError2["NO_SUCH_REQUEST"] = "Smart contract panicked: panicked at 'No such request: either wrong number or already confirmed'";
  MultisigDeleteRequestRejectionError2["REQUEST_COOLDOWN_ERROR"] = "Request cannot be deleted immediately after creation.";
  MultisigDeleteRequestRejectionError2["METHOD_NOT_FOUND"] = "Contract method is not found";
  return MultisigDeleteRequestRejectionError2;
})(MultisigDeleteRequestRejectionError || {});
var MultisigStateStatus = /* @__PURE__ */ ((MultisigStateStatus2) => {
  MultisigStateStatus2[MultisigStateStatus2["INVALID_STATE"] = 0] = "INVALID_STATE";
  MultisigStateStatus2[MultisigStateStatus2["STATE_NOT_INITIALIZED"] = 1] = "STATE_NOT_INITIALIZED";
  MultisigStateStatus2[MultisigStateStatus2["VALID_STATE"] = 2] = "VALID_STATE";
  MultisigStateStatus2[MultisigStateStatus2["UNKNOWN_STATE"] = 3] = "UNKNOWN_STATE";
  return MultisigStateStatus2;
})(MultisigStateStatus || {});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MultisigDeleteRequestRejectionError,
  MultisigStateStatus
});

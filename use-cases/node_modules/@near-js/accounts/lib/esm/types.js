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
export {
  MultisigDeleteRequestRejectionError,
  MultisigStateStatus
};

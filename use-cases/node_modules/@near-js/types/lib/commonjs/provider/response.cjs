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
var response_exports = {};
__export(response_exports, {
  ExecutionStatusBasic: () => ExecutionStatusBasic,
  FinalExecutionStatusBasic: () => FinalExecutionStatusBasic
});
module.exports = __toCommonJS(response_exports);
var ExecutionStatusBasic = /* @__PURE__ */ ((ExecutionStatusBasic2) => {
  ExecutionStatusBasic2["Unknown"] = "Unknown";
  ExecutionStatusBasic2["Pending"] = "Pending";
  ExecutionStatusBasic2["Failure"] = "Failure";
  return ExecutionStatusBasic2;
})(ExecutionStatusBasic || {});
var FinalExecutionStatusBasic = /* @__PURE__ */ ((FinalExecutionStatusBasic2) => {
  FinalExecutionStatusBasic2["NotStarted"] = "NotStarted";
  FinalExecutionStatusBasic2["Started"] = "Started";
  FinalExecutionStatusBasic2["Failure"] = "Failure";
  return FinalExecutionStatusBasic2;
})(FinalExecutionStatusBasic || {});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ExecutionStatusBasic,
  FinalExecutionStatusBasic
});

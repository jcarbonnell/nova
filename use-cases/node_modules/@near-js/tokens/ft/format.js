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
var format_exports = {};
__export(format_exports, {
  MAX_NOMINATION_EXP: () => MAX_NOMINATION_EXP,
  formatAmount: () => formatAmount,
  parseAmount: () => parseAmount
});
module.exports = __toCommonJS(format_exports);
const MAX_NOMINATION_EXP = 24;
function formatAmount(units, fracDigits, precision = fracDigits) {
  units = cleanupUnits(units);
  const wholeStr = units.substring(0, units.length - fracDigits) || "0";
  let fractionStr = units.substring(units.length - fracDigits).substring(0, fracDigits).padStart(fracDigits, "0");
  fractionStr = fractionStr.substring(0, precision);
  return trimTrailingZeroes(`${wholeStr}.${fractionStr}`);
}
function parseAmount(amount, fracDigits) {
  amount = cleanupAmount(amount);
  const split = amount.split(".");
  if (split.length > 2) {
    throw new Error(
      `Cannot parse amount '${amount}' as it contains more than a single dot`
    );
  }
  const wholePart = split[0];
  const fracPart = split[1] || "";
  if (fracPart.length > MAX_NOMINATION_EXP) {
    throw new Error(
      `Cannot parse amount '${amount}' as it exceeds maximum decimal precision of ${MAX_NOMINATION_EXP}`
    );
  }
  return trimLeadingZeroes(
    wholePart + fracPart.substring(0, fracDigits).padEnd(fracDigits, "0")
  );
}
function cleanupAmount(amount) {
  return amount.replace(/,/g, ".").trim();
}
function trimTrailingZeroes(value) {
  return value.replace(/\.?0*$/, "");
}
function trimLeadingZeroes(value) {
  value = value.replace(/^0+/, "");
  if (value === "") {
    return "0";
  }
  return value;
}
function cleanupUnits(amount) {
  return BigInt(amount).toString();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_NOMINATION_EXP,
  formatAmount,
  parseAmount
});

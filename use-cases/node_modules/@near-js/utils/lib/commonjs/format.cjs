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

// src/format.ts
var format_exports = {};
__export(format_exports, {
  NEAR_NOMINATION: () => NEAR_NOMINATION,
  NEAR_NOMINATION_EXP: () => NEAR_NOMINATION_EXP,
  baseDecode: () => baseDecode,
  baseEncode: () => baseEncode,
  formatNearAmount: () => formatNearAmount,
  parseNearAmount: () => parseNearAmount
});
module.exports = __toCommonJS(format_exports);
var import_base = require("@scure/base");
var NEAR_NOMINATION_EXP = 24;
var NEAR_NOMINATION = 10n ** BigInt(NEAR_NOMINATION_EXP);
var ROUNDING_OFFSETS = [];
var BN10 = 10n;
for (let i = 0, offset = 5n; i < NEAR_NOMINATION_EXP; i++, offset = offset * BN10) {
  ROUNDING_OFFSETS[i] = offset;
}
function formatNearAmount(balance, fracDigits = NEAR_NOMINATION_EXP) {
  let balanceBN = BigInt(balance);
  if (fracDigits !== NEAR_NOMINATION_EXP) {
    const roundingExp = NEAR_NOMINATION_EXP - fracDigits - 1;
    if (roundingExp > 0) {
      balanceBN += ROUNDING_OFFSETS[roundingExp];
    }
  }
  balance = balanceBN.toString();
  const wholeStr = balance.substring(0, balance.length - NEAR_NOMINATION_EXP) || "0";
  const fractionStr = balance.substring(balance.length - NEAR_NOMINATION_EXP).padStart(NEAR_NOMINATION_EXP, "0").substring(0, fracDigits);
  return trimTrailingZeroes(`${formatWithCommas(wholeStr)}.${fractionStr}`);
}
function parseNearAmount(amt) {
  if (!amt) {
    return null;
  }
  amt = cleanupAmount(amt);
  const split = amt.split(".");
  const wholePart = split[0];
  const fracPart = split[1] || "";
  if (split.length > 2 || fracPart.length > NEAR_NOMINATION_EXP) {
    throw new Error(`Cannot parse '${amt}' as NEAR amount`);
  }
  return trimLeadingZeroes(
    wholePart + fracPart.padEnd(NEAR_NOMINATION_EXP, "0")
  );
}
function cleanupAmount(amount) {
  return amount.replace(/,/g, "").trim();
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
function formatWithCommas(value) {
  const pattern = /(-?\d+)(\d{3})/;
  while (pattern.test(value)) {
    value = value.replace(pattern, "$1,$2");
  }
  return value;
}
function baseEncode(value) {
  if (typeof value === "string") {
    const bytes = [];
    for (let c = 0; c < value.length; c++) {
      bytes.push(value.charCodeAt(c));
    }
    value = new Uint8Array(bytes);
  }
  return import_base.base58.encode(value);
}
function baseDecode(value) {
  return import_base.base58.decode(value);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  NEAR_NOMINATION,
  NEAR_NOMINATION_EXP,
  baseDecode,
  baseEncode,
  formatNearAmount,
  parseNearAmount
});

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/validators.ts
var validators_exports = {};
__export(validators_exports, {
  diffEpochValidators: () => diffEpochValidators,
  findSeatPrice: () => findSeatPrice
});
module.exports = __toCommonJS(validators_exports);
var import_depd = __toESM(require("depd"), 1);

// src/utils.ts
function sortBigIntAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/validators.ts
function findSeatPrice(validators, maxNumberOfSeats, minimumStakeRatio, protocolVersion) {
  if (protocolVersion && protocolVersion < 49) {
    return findSeatPriceForProtocolBefore49(validators, maxNumberOfSeats);
  }
  if (!minimumStakeRatio) {
    const deprecate = (0, import_depd.default)("findSeatPrice(validators, maxNumberOfSeats)");
    deprecate("`use `findSeatPrice(validators, maxNumberOfSeats, minimumStakeRatio)` instead");
    minimumStakeRatio = [1, 6250];
  }
  return findSeatPriceForProtocolAfter49(validators, maxNumberOfSeats, minimumStakeRatio);
}
function findSeatPriceForProtocolBefore49(validators, numSeats) {
  const stakes = validators.map((v) => BigInt(v.stake)).sort(sortBigIntAsc);
  const num = BigInt(numSeats);
  const stakesSum = stakes.reduce((a, b) => a + b);
  if (stakesSum < num) {
    throw new Error("Stakes are below seats");
  }
  let left = 1n, right = stakesSum + 1n;
  while (left !== right - 1n) {
    const mid = (left + right) / 2n;
    let found = false;
    let currentSum = 0n;
    for (let i = 0; i < stakes.length; ++i) {
      currentSum = currentSum + stakes[i] / mid;
      if (currentSum >= num) {
        left = mid;
        found = true;
        break;
      }
    }
    if (!found) {
      right = mid;
    }
  }
  return left;
}
function findSeatPriceForProtocolAfter49(validators, maxNumberOfSeats, minimumStakeRatio) {
  if (minimumStakeRatio.length != 2) {
    throw Error("minimumStakeRatio should have 2 elements");
  }
  const stakes = validators.map((v) => BigInt(v.stake)).sort(sortBigIntAsc);
  const stakesSum = stakes.reduce((a, b) => a + b);
  if (validators.length < maxNumberOfSeats) {
    return stakesSum * BigInt(minimumStakeRatio[0]) / BigInt(minimumStakeRatio[1]);
  } else {
    return stakes[0] + 1n;
  }
}
function diffEpochValidators(currentValidators, nextValidators) {
  const validatorsMap = /* @__PURE__ */ new Map();
  currentValidators.forEach((v) => validatorsMap.set(v.account_id, v));
  const nextValidatorsSet = new Set(nextValidators.map((v) => v.account_id));
  return {
    newValidators: nextValidators.filter((v) => !validatorsMap.has(v.account_id)),
    removedValidators: currentValidators.filter((v) => !nextValidatorsSet.has(v.account_id)),
    changedValidators: nextValidators.filter((v) => validatorsMap.has(v.account_id) && validatorsMap.get(v.account_id).stake != v.stake).map((v) => ({ current: validatorsMap.get(v.account_id), next: v }))
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  diffEpochValidators,
  findSeatPrice
});

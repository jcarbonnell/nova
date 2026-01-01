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
var prefix_exports = {};
__export(prefix_exports, {
  DelegateActionPrefix: () => DelegateActionPrefix
});
module.exports = __toCommonJS(prefix_exports);
const ACTIONABLE_MESSAGE_BASE = Math.pow(2, 30);
const NEP = {
  MetaTransactions: 366
};
class NEPPrefix {
  prefix;
  constructor({ prefix }) {
    this.prefix = prefix;
  }
}
class ActionableMessagePrefix extends NEPPrefix {
  /** Given the NEP number, set the prefix using 2^30 as the offset **/
  constructor(prefix) {
    super({ prefix: ACTIONABLE_MESSAGE_BASE + prefix });
  }
}
class DelegateActionPrefix extends ActionableMessagePrefix {
  constructor() {
    super(NEP.MetaTransactions);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DelegateActionPrefix
});

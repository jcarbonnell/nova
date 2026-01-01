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
var contract_exports = {};
__export(contract_exports, {
  Contract: () => Contract
});
module.exports = __toCommonJS(contract_exports);
var import_utils = require("@near-js/utils");
var import_types = require("@near-js/types");
var import_local_view_execution = require('./local-view-execution/index.cjs');
var import_is_my_json_valid = __toESM(require("is-my-json-valid"), 1);
var import_depd = __toESM(require("depd"), 1);
var import_near_abi = require("near-abi");
var import_account = require('./account.cjs');
var import_errors = require('./errors.cjs');
var import_utils2 = require('./utils.cjs');
function nameFunction(name, body) {
  return {
    [name](...args) {
      return body(...args);
    }
  }[name];
}
function validateArguments(args, abiFunction, abiRoot) {
  if (!isObject(args)) return;
  if (abiFunction.params && abiFunction.params.serialization_type !== import_near_abi.AbiSerializationType.Json) {
    throw new import_errors.UnsupportedSerializationError(
      abiFunction.name,
      abiFunction.params.serialization_type
    );
  }
  if (abiFunction.result && abiFunction.result.serialization_type !== import_near_abi.AbiSerializationType.Json) {
    throw new import_errors.UnsupportedSerializationError(
      abiFunction.name,
      abiFunction.result.serialization_type
    );
  }
  const params = abiFunction.params?.args || [];
  for (const p of params) {
    const arg = args[p.name];
    const typeSchema = p.type_schema;
    typeSchema.definitions = abiRoot.body.root_schema.definitions;
    const validate = (0, import_is_my_json_valid.default)(typeSchema);
    const valid = validate(arg);
    if (!valid) {
      throw new import_errors.ArgumentSchemaError(p.name, validate.errors);
    }
  }
  for (const argName of Object.keys(args)) {
    const param = params.find((p) => p.name === argName);
    if (!param) {
      throw new import_errors.UnknownArgumentError(
        argName,
        params.map((p) => p.name)
      );
    }
  }
}
const isUint8Array = (x) => x && x.byteLength !== void 0 && x.byteLength === x.length;
const isObject = (x) => Object.prototype.toString.call(x) === "[object Object]";
class Contract {
  /** @deprecated */
  account;
  connection;
  contractId;
  lve;
  /**
   * @param account NEAR account to sign change method transactions
   * @param contractId NEAR account id where the contract is deployed
   * @param options NEAR smart contract methods that your application will use. These will be available as `contract.methodName`
   */
  constructor(connection, contractId, options) {
    const deprecate = (0, import_depd.default)("new Contract()");
    deprecate(
      'It will be removed in the next major release, please switch to "TypedContract" with type-safe ABI support'
    );
    this.connection = connection.getConnection();
    if (connection instanceof import_account.Account) {
      const deprecate2 = (0, import_depd.default)(
        "new Contract(account, contractId, options)"
      );
      deprecate2(
        "use `new Contract(connection, contractId, options)` instead"
      );
      this.account = connection;
    }
    this.contractId = contractId;
    this.lve = new import_local_view_execution.LocalViewExecution(connection);
    const {
      viewMethods = [],
      changeMethods = [],
      abi: abiRoot,
      useLocalViewExecution
    } = options;
    let viewMethodsWithAbi = viewMethods.map((name) => ({
      name,
      abi: null
    }));
    let changeMethodsWithAbi = changeMethods.map((name) => ({
      name,
      abi: null
    }));
    if (abiRoot) {
      if (viewMethodsWithAbi.length > 0 || changeMethodsWithAbi.length > 0) {
        throw new import_errors.ConflictingOptions();
      }
      viewMethodsWithAbi = abiRoot.body.functions.filter((m) => m.kind === import_near_abi.AbiFunctionKind.View).map((m) => ({ name: m.name, abi: m }));
      changeMethodsWithAbi = abiRoot.body.functions.filter((methodAbi) => methodAbi.kind === import_near_abi.AbiFunctionKind.Call).map((methodAbi) => ({ name: methodAbi.name, abi: methodAbi }));
    }
    viewMethodsWithAbi.forEach(({ name, abi }) => {
      Object.defineProperty(this, name, {
        writable: false,
        enumerable: true,
        value: nameFunction(
          name,
          async (args = {}, options2 = {}, ...ignored) => {
            if (ignored.length || !(isObject(args) || isUint8Array(args)) || !isObject(options2)) {
              throw new import_types.PositionalArgsError();
            }
            if (abi) {
              validateArguments(args, abi, abiRoot);
            }
            if (useLocalViewExecution) {
              try {
                return await this.lve.viewFunction({
                  contractId: this.contractId,
                  methodName: name,
                  args,
                  ...options2
                });
              } catch (error) {
                import_utils.Logger.warn(
                  `Local view execution failed with: "${error.message}"`
                );
                import_utils.Logger.warn(`Fallback to normal RPC call`);
              }
            }
            if (this.account) {
              return this.account.viewFunction({
                contractId: this.contractId,
                methodName: name,
                args,
                ...options2
              });
            }
            return (0, import_utils2.viewFunction)(this.connection, {
              contractId: this.contractId,
              methodName: name,
              args,
              ...options2
            });
          }
        )
      });
    });
    changeMethodsWithAbi.forEach(({ name, abi }) => {
      Object.defineProperty(this, name, {
        writable: false,
        enumerable: true,
        value: nameFunction(name, async (...args) => {
          if (args.length && (args.length > 3 || !(isObject(args[0]) || isUint8Array(args[0])))) {
            throw new import_types.PositionalArgsError();
          }
          if (args.length > 1 || !(args[0] && args[0].args)) {
            const deprecate2 = (0, import_depd.default)(
              "contract.methodName(args, gas, amount)"
            );
            deprecate2(
              "use `contract.methodName({ signerAccount, args, gas?, amount?, callbackUrl?, meta? })` instead"
            );
            args[0] = {
              args: args[0],
              gas: args[1],
              amount: args[2]
            };
          }
          if (abi) {
            validateArguments(args[0].args, abi, abiRoot);
          }
          return this._changeMethod({ methodName: name, ...args[0] });
        })
      });
    });
  }
  async _changeMethod({
    signerAccount,
    args,
    methodName,
    gas,
    amount,
    meta,
    callbackUrl
  }) {
    validateBNLike({ gas, amount });
    const account = this.account || signerAccount;
    if (!account) throw new Error(`signerAccount must be specified`);
    const rawResult = await account.functionCall({
      contractId: this.contractId,
      methodName,
      args,
      gas,
      attachedDeposit: amount,
      walletMeta: meta,
      walletCallbackUrl: callbackUrl
    });
    return (0, import_utils.getTransactionLastResult)(rawResult);
  }
}
function validateBNLike(argMap) {
  const bnLike = "number, decimal string or BigInt";
  for (const argName of Object.keys(argMap)) {
    const argValue = argMap[argName];
    if (argValue && typeof argValue !== "bigint" && isNaN(argValue)) {
      throw new import_types.ArgumentTypeError(argName, bnLike, argValue);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Contract
});

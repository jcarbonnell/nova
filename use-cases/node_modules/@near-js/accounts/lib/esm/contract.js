import { getTransactionLastResult, Logger } from "@near-js/utils";
import { ArgumentTypeError, PositionalArgsError } from "@near-js/types";
import { LocalViewExecution } from "./local-view-execution/index.js";
import validator from "is-my-json-valid";
import depd from "depd";
import {
  AbiFunctionKind,
  AbiSerializationType
} from "near-abi";
import { Account } from "./account.js";
import {
  UnsupportedSerializationError,
  UnknownArgumentError,
  ArgumentSchemaError,
  ConflictingOptions
} from "./errors.js";
import { viewFunction } from "./utils.js";
function nameFunction(name, body) {
  return {
    [name](...args) {
      return body(...args);
    }
  }[name];
}
function validateArguments(args, abiFunction, abiRoot) {
  if (!isObject(args)) return;
  if (abiFunction.params && abiFunction.params.serialization_type !== AbiSerializationType.Json) {
    throw new UnsupportedSerializationError(
      abiFunction.name,
      abiFunction.params.serialization_type
    );
  }
  if (abiFunction.result && abiFunction.result.serialization_type !== AbiSerializationType.Json) {
    throw new UnsupportedSerializationError(
      abiFunction.name,
      abiFunction.result.serialization_type
    );
  }
  const params = abiFunction.params?.args || [];
  for (const p of params) {
    const arg = args[p.name];
    const typeSchema = p.type_schema;
    typeSchema.definitions = abiRoot.body.root_schema.definitions;
    const validate = validator(typeSchema);
    const valid = validate(arg);
    if (!valid) {
      throw new ArgumentSchemaError(p.name, validate.errors);
    }
  }
  for (const argName of Object.keys(args)) {
    const param = params.find((p) => p.name === argName);
    if (!param) {
      throw new UnknownArgumentError(
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
    const deprecate = depd("new Contract()");
    deprecate(
      'It will be removed in the next major release, please switch to "TypedContract" with type-safe ABI support'
    );
    this.connection = connection.getConnection();
    if (connection instanceof Account) {
      const deprecate2 = depd(
        "new Contract(account, contractId, options)"
      );
      deprecate2(
        "use `new Contract(connection, contractId, options)` instead"
      );
      this.account = connection;
    }
    this.contractId = contractId;
    this.lve = new LocalViewExecution(connection);
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
        throw new ConflictingOptions();
      }
      viewMethodsWithAbi = abiRoot.body.functions.filter((m) => m.kind === AbiFunctionKind.View).map((m) => ({ name: m.name, abi: m }));
      changeMethodsWithAbi = abiRoot.body.functions.filter((methodAbi) => methodAbi.kind === AbiFunctionKind.Call).map((methodAbi) => ({ name: methodAbi.name, abi: methodAbi }));
    }
    viewMethodsWithAbi.forEach(({ name, abi }) => {
      Object.defineProperty(this, name, {
        writable: false,
        enumerable: true,
        value: nameFunction(
          name,
          async (args = {}, options2 = {}, ...ignored) => {
            if (ignored.length || !(isObject(args) || isUint8Array(args)) || !isObject(options2)) {
              throw new PositionalArgsError();
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
                Logger.warn(
                  `Local view execution failed with: "${error.message}"`
                );
                Logger.warn(`Fallback to normal RPC call`);
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
            return viewFunction(this.connection, {
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
            throw new PositionalArgsError();
          }
          if (args.length > 1 || !(args[0] && args[0].args)) {
            const deprecate2 = depd(
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
    return getTransactionLastResult(rawResult);
  }
}
function validateBNLike(argMap) {
  const bnLike = "number, decimal string or BigInt";
  for (const argName of Object.keys(argMap)) {
    const argValue = argMap[argName];
    if (argValue && typeof argValue !== "bigint" && isNaN(argValue)) {
      throw new ArgumentTypeError(argName, bnLike, argValue);
    }
  }
}
export {
  Contract
};

import { ArgumentSchemaError, UnknownArgumentError } from "./errors.js";
import validator from "is-my-json-valid";
class Contract {
  abi;
  contractId;
  view;
  call;
  constructor({
    abi,
    provider,
    contractId
  }) {
    this.contractId = contractId;
    this.abi = abi;
    let hasViewFunction = false;
    let hasCallFunction = false;
    const abiFunctions = abi?.body.functions || [];
    for (const func of abiFunctions) {
      if (func.kind === "view") {
        hasViewFunction = true;
      } else if (func.kind === "call") {
        hasCallFunction = true;
      }
      if (hasViewFunction && hasCallFunction) break;
    }
    if (hasViewFunction || !abi) {
      this.view = new Proxy(
        {},
        {
          get: (_, functionName) => {
            const abiFunction = (abi?.body.functions || []).find(
              ({ name }) => name === functionName
            );
            return async (params = {}) => {
              const args = params.args ?? {};
              if (abiFunction && abi) {
                validateArguments(args, abiFunction, abi);
              }
              return provider.callFunction(
                contractId,
                functionName,
                args,
                params.blockQuery
              );
            };
          }
        }
      );
    }
    if (hasCallFunction || !abi) {
      this.call = new Proxy(
        {},
        {
          get: (_, functionName) => {
            const abiFunction = (abi?.body.functions || []).find(
              ({ name }) => name === functionName
            );
            return async (params) => {
              const args = params.args ?? {};
              if (abiFunction && abi) {
                validateArguments(args, abiFunction, abi);
              }
              return params.account.callFunction({
                contractId,
                methodName: functionName,
                args,
                deposit: params.deposit,
                gas: params.gas,
                waitUntil: params.waitUntil
              });
            };
          }
        }
      );
    }
    if (!abi) {
      delete this.abi;
    }
  }
}
const TypedContract = Contract;
function validateArguments(args, abiFunction, abiRoot) {
  if (typeof args !== "object" || typeof abiFunction.params !== "object")
    return;
  if (abiFunction.params.serialization_type === "json") {
    const params = abiFunction.params.args;
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
}
export {
  TypedContract
};

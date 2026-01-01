import {
  PositionalArgsError
} from "@near-js/types";
import { printTxOutcomeLogs } from "@near-js/utils";
import depd from "depd";
function parseJsonFromRawResponse(response) {
  return JSON.parse(Buffer.from(response).toString());
}
function bytesJsonStringify(input) {
  return Buffer.from(JSON.stringify(input));
}
function validateArgs(args) {
  const isUint8Array = args.byteLength !== void 0 && args.byteLength === args.length;
  if (isUint8Array) {
    return;
  }
  if (Array.isArray(args) || typeof args !== "object") {
    throw new PositionalArgsError();
  }
}
async function viewState(connection, accountId, prefix, blockQuery = { finality: "optimistic" }) {
  const deprecate = depd("viewState()");
  deprecate("It will be removed in the next major release");
  const { values } = await connection.provider.query({
    request_type: "view_state",
    ...blockQuery,
    account_id: accountId,
    prefix_base64: Buffer.from(prefix).toString("base64")
  });
  return values.map(({ key, value }) => ({
    key: Buffer.from(key, "base64"),
    value: Buffer.from(value, "base64")
  }));
}
async function viewFunction(connection, {
  contractId,
  methodName,
  args = {},
  parse = parseJsonFromRawResponse,
  stringify = bytesJsonStringify,
  blockQuery = { finality: "optimistic" }
}) {
  const deprecate = depd("viewFunction()");
  deprecate("It will be removed in the next major release");
  validateArgs(args);
  const encodedArgs = stringify(args);
  const result = await connection.provider.query({
    request_type: "call_function",
    ...blockQuery,
    account_id: contractId,
    method_name: methodName,
    args_base64: encodedArgs.toString("base64")
  });
  if (result.logs) {
    printTxOutcomeLogs({ contractId, logs: result.logs });
  }
  return result.result && result.result.length > 0 && parse(Buffer.from(result.result));
}
export {
  validateArgs,
  viewFunction,
  viewState
};

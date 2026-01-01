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
var fetch_json_exports = {};
__export(fetch_json_exports, {
  ProviderError: () => ProviderError,
  fetchJsonRpc: () => fetchJsonRpc,
  retryConfig: () => retryConfig
});
module.exports = __toCommonJS(fetch_json_exports);
var import_types = require("@near-js/types");
var import_exponential_backoff = require("exponential-backoff");
const BACKOFF_MULTIPLIER = 1.5;
const RETRY_NUMBER = 10;
const RETRY_DELAY = 0;
function retryConfig(numOfAttempts = RETRY_NUMBER, timeMultiple = BACKOFF_MULTIPLIER, startingDelay = RETRY_DELAY) {
  return {
    numOfAttempts,
    timeMultiple,
    startingDelay,
    retry: (e) => {
      if ([503, 500, 408].includes(e.cause)) {
        return true;
      }
      if (e.toString().includes("FetchError") || e.toString().includes("Failed to fetch")) {
        return true;
      }
      return false;
    }
  };
}
class ProviderError extends Error {
  cause;
  constructor(message, options) {
    super(message, options);
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}
async function fetchJsonRpc(url, json, headers, retryConfig2) {
  const response = await (0, import_exponential_backoff.backOff)(async () => {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify(json),
      headers: { ...headers, "Content-Type": "application/json" }
    });
    const { ok, status } = res;
    if (status === 500) {
      throw new ProviderError("Internal server error", { cause: status });
    } else if (status === 408) {
      throw new ProviderError("Timeout error", { cause: status });
    } else if (status === 400) {
      throw new ProviderError("Request validation error", { cause: status });
    } else if (status === 503) {
      throw new ProviderError(`${url} unavailable`, { cause: status });
    }
    if (!ok) {
      throw new ProviderError(await res.text(), { cause: status });
    }
    return res;
  }, retryConfig2);
  if (!response) {
    throw new import_types.TypedError(`Exceeded ${RETRY_NUMBER} attempts for ${url}.`, "RetriesExceeded");
  }
  return await response.json();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ProviderError,
  fetchJsonRpc,
  retryConfig
});

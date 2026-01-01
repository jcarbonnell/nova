import { TypedError } from "@near-js/types";
import { backOff } from "exponential-backoff";
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
  const response = await backOff(async () => {
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
    throw new TypedError(`Exceeded ${RETRY_NUMBER} attempts for ${url}.`, "RetriesExceeded");
  }
  return await response.json();
}
export {
  ProviderError,
  fetchJsonRpc,
  retryConfig
};

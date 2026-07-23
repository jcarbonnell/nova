// shade-agent/src/lib/errors.ts
//
// One error shape for every route. Roadmap §4:
//   "ApiError class with { statusCode, code, message, details }.
//    All routes catch and return via the same shape."
//
// WIRE-FORMAT CONSTRAINT (do not change without auditing consumers):
//   `error` MUST stay a top-level STRING. The frontend reads it directly
//   (`errorData.error || 'Invalid API key'`); nesting it would render
//   "[object Object]" in every error path. `code` is the machine-readable
//   handle, added alongside — purely additive, matching the shape the v0.4
//   wallet 501s already ship:
//       { "error": "Wallet auth disabled …", "code": "WALLET_AUTH_PENDING_SELF_CUSTODY" }
//   MCP only reads resp.status_code and raw resp.text[:200] — it never parses
//   this JSON, so it is unaffected either way.

/** The status codes actually used by NOVA's routes. */
export type ApiStatus = 400 | 401 | 403 | 404 | 429 | 500 | 501;

export class ApiError extends Error {
  constructor(
    public readonly statusCode: ApiStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
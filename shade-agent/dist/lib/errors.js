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
import { log } from './logger.js';
export class ApiError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.name = 'ApiError';
    }
}
/**
 * Centralized error handler. Mount on each router with `router.onError(errorHandler)`.
 *
 * v0.4 BEHAVIOUR CHANGE (deliberate): unhandled exceptions no longer leak their
 * internal message to the caller. Routes previously did:
 *     return c.json({ error: 'Failed to retrieve key', details: err.message }, 500)
 * which shipped raw exception text — RPC URLs, config errors like
 * "TEE_KEY_SECRET must be a 64-char hex string", etc. — to anyone who could
 * reach the endpoint. Now the real error is logged server-side in full and the
 * caller gets an opaque { error: "Internal error", code: "INTERNAL" }.
 *
 * Deliberate, expected errors are still fully described: throw ApiError with the
 * message you want the caller to see.
 */
export const errorHandler = (err, c) => {
    if (err instanceof ApiError) {
        log(err.statusCode >= 500 ? 'error' : 'warn', 'api_error', {
            code: err.code,
            status: err.statusCode,
            path: c.req.path,
        });
        const body = { error: err.message, code: err.code };
        if (err.details !== undefined)
            body.details = err.details;
        return c.json(body, err.statusCode);
    }
    // Unexpected. Log everything we have; tell the caller nothing.
    log('error', 'unhandled_error', {
        path: c.req.path,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json({ error: 'Internal error', code: 'INTERNAL' }, 500);
};

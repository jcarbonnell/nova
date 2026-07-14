// shade-agent/src/rpc/base.ts
//
// The oRPC foundation: context shape, the internal-auth gate, and the bridge
// from our ApiError to oRPC's ORPCError.
//
// WHY THE GATE IS oRPC MIDDLEWARE AND NOT HONO MIDDLEWARE:
// oRPC reads the request body itself. If a Hono middleware reads the body first
// (ours does — `validate()` calls c.req.json()), oRPC throws. So the /rpc mount
// must have NO body-reading Hono middleware in front of it, and the gate has to
// run inside oRPC. Same invariant — gate outermost, fails closed — different
// mechanism. The parity harness asserts it: malformed body + no secret => 403,
// never 400.

import { os, ORPCError } from '@orpc/server';

import { checkInternalAuth } from '../lib/auth.js';
import { initializeMasterSeed } from '../lib/seed.js';
import { ApiError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/** Context handed in by the Hono adapter. Headers only — services stay HTTP-free. */
export type RpcContext = {
  headers: Headers;
};

const base = os.$context<RpcContext>();

// ────────────────────────────────────────────────
// 1. Internal auth gate (v0.3.2 Fix 3) — OUTERMOST
// ────────────────────────────────────────────────

export const requireInternalAuth = base.middleware(async ({ context, next }) => {
  if (!checkInternalAuth(context.headers.get('x-internal-auth') ?? undefined)) {
    // 403 with a bare string body, matching the Hono gate byte-for-byte.
    throw new ORPCError('FORBIDDEN', { status: 403, message: 'Forbidden' });
  }
  return next();
});

// ────────────────────────────────────────────────
// 2. Master seed (idempotent; returns early once loaded)
// ────────────────────────────────────────────────

export const withMasterSeed = base.middleware(async ({ next }) => {
  await initializeMasterSeed();
  return next();
});

// ────────────────────────────────────────────────
// 3. ApiError -> ORPCError
// ────────────────────────────────────────────────
//
// Services throw ApiError (they know nothing about oRPC). This converts it,
// preserving status, code and message exactly. `customErrorResponseBodyEncoder`
// in rpc/mount.ts then renders it as { error, code } — our wire format.
//
// Anything that is NOT an ApiError is an unexpected throw: log it in full
// server-side, and let oRPC emit its generic 500. Never leak internals.

export const mapErrors = base.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ORPCError(err.code, {
        status: err.statusCode,
        message: err.message,
        data: err.details,
      });
    }
    if (err instanceof ORPCError) throw err; // already ours (e.g. the gate)

    log('error', 'rpc_unhandled_error', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new ORPCError('INTERNAL', { status: 500, message: 'Internal error' });
  }
});

// ────────────────────────────────────────────────
// The builder every procedure starts from.
// Order matters and mirrors the Hono stack: gate -> seed -> (Zod, by oRPC) -> handler.
// ────────────────────────────────────────────────

export const pub = base
  .use(mapErrors)          // outermost catch, so gate errors are shaped correctly too
  .use(requireInternalAuth)
  .use(withMasterSeed);

// shade-agent/src/rpc/mount.ts
//
// Mounts the oRPC router onto the existing Hono app at /rpc.
//
// STRANGLER FIG: the legacy Hono routes at /api/user-keys/* and
// /api/key-management/* stay exactly where they are and keep working. Both
// surfaces call the SAME services. Nothing that works today changes.
// Sequence: prove parity in production -> flip MCP + frontend to /rpc -> delete
// the Hono adapters. On a single CVM with no staging, that is the only
// responsible order.
//
// ⚠️ MOUNT WITH NO BODY-READING MIDDLEWARE IN FRONT. oRPC parses the request
// body itself; if Hono middleware consumed it first, oRPC would throw.

import type { Hono } from 'hono';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { onError } from '@orpc/server';

import { router } from './router.js';
import { log } from '../lib/logger.js';

export const RPC_PREFIX = '/rpc';

const handler = new OpenAPIHandler(router, {
  /**
   * OUR WIRE FORMAT — non-negotiable.
   *
   * oRPC's default error body is { defined, code, status, message, data }.
   * Ours is { error: <string>, code: <string>, details? }.
   *
   * `error` MUST be a top-level STRING: the frontend does
   * `errorData.error || '…'`, and nesting it would render "[object Object]" in
   * every error path. This encoder is what keeps the two surfaces
   * byte-compatible. Do not "simplify" it.
   */
  customErrorResponseBodyEncoder(error) {
    // oRPC validates .input() itself, so validation failures arrive as its own
    // BAD_REQUEST with data.issues. Remap to the legacy VALIDATION_FAILED shape so
    // both surfaces are byte-compatible.
    const data = error.data as { issues?: Array<{ path: (string | number)[]; message: string }> } | undefined;
    if (error.code === 'BAD_REQUEST' && Array.isArray(data?.issues)) {
      return {
        error: 'Invalid request body',
        code: 'VALIDATION_FAILED',
        details: data.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    }

    const body: Record<string, unknown> = {
      error: error.message,
      code: error.code,
    };
    if (error.data !== undefined) body.details = error.data;
    return body;
  },

  interceptors: [
    onError((error) => {
      log('warn', 'rpc_error', {
        code: (error as { code?: string }).code,
        status: (error as { status?: number }).status,
      });
    }),
  ],
});

/**
 * Mount on the Hono app. Call BEFORE app.route('/api/...') is irrelevant —
 * prefixes don't collide — but call it after CORS so preflight still works.
 */
export function mountRpc(app: Hono): void {
  app.use(`${RPC_PREFIX}/*`, async (c, next) => {
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: RPC_PREFIX,
      context: { headers: c.req.raw.headers },
    });

    if (matched) {
      return c.newResponse(response.body, response);
    }
    await next();
  });
}

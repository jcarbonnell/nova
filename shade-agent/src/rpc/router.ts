// shade-agent/src/rpc/router.ts
//
// oRPC procedures. A SECOND thin adapter over lib/services/* — the Hono routes
// are the first. One implementation, two surfaces, so parity is structural
// rather than tested. (Tested anyway: see test-rpc-parity.mjs.)
//
// EVERY procedure here is tagged `internal`. The Shade Agent's entire API sits
// behind the X-Internal-Auth gate; none of it is public. The tag drives the
// OpenAPI `filter` (scripts/generate-openapi.ts), so the published spec is empty
// by construction — and `retrieve`, which returns a PRIVATE KEY, can never leak
// into a public document by accident.
//
// The public NOVA contract (step 6.3) describes MCP's /tools/* and lives in
// nova-contract/. It never mentions key material.

import { pub } from './base.js';
import {
  StoreSchema, RetrieveSchema, CheckSchema, ApiKeyLookupSchema, VerifyApiKeySchema,
  GenerateKeySchema, GetKeySchema, RevokeMemberSchema, RotateKeySchema,
  StoreOutput, RetrieveOutput, CheckOutput, GenerateApiKeyOutput, HasApiKeyOutput,
  VerifyApiKeyOutput, GenerateKeyOutput, GetKeyOutput, RevokeMemberOutput, RotateKeyOutput,
} from '../lib/schemas.js';
import * as userKeysService from '../lib/services/user-keys.js';
import * as keyMgmtService from '../lib/services/key-management.js';
import { ApiError } from '../lib/errors.js';

const INTERNAL = ['internal'];

// ────────────────────────────────────────────────
// user-keys
// ────────────────────────────────────────────────

const store = pub
  .route({
    method: 'POST',
    path: '/user-keys/store',
    tags: INTERNAL,
    summary: 'Store a user keypair (encrypted) in KV',
  })
  .input(StoreSchema)
  .output(StoreOutput)
  .handler(({ input }) => userKeysService.storeUserKey(input));

// NOTE: rate limiting is NOT applied here. The Hono /store route rate-limits by
// x-forwarded-for. Callers of /rpc are the same two gated services, so the risk
// is the same — but this is a behavioural gap between the two surfaces and must
// be closed before the Hono route is retired (step 6.4). Tracked.

const retrieve = pub
  .route({
    method: 'POST',
    path: '/user-keys/retrieve',
    tags: INTERNAL,
    summary: '⚠️ Returns a PRIVATE KEY. Internal signing path only.',
  })
  .input(RetrieveSchema)
  .output(RetrieveOutput)
  .handler(({ input }) => userKeysService.retrieveUserKey(input));

const check = pub
  .route({ method: 'POST', path: '/user-keys/check', tags: INTERNAL })
  .input(CheckSchema)
  .output(CheckOutput)
  .handler(({ input }) => userKeysService.checkAccount(input));

const generateApiKey = pub
  .route({ method: 'POST', path: '/user-keys/generate-api-key', tags: INTERNAL })
  .input(ApiKeyLookupSchema)
  .output(GenerateApiKeyOutput)
  .handler(({ input }) => userKeysService.generateApiKey(input));

const hasApiKey = pub
  .route({ method: 'POST', path: '/user-keys/has-api-key', tags: INTERNAL })
  .input(ApiKeyLookupSchema)
  .output(HasApiKeyOutput)
  .handler(({ input }) => userKeysService.hasApiKey(input));

/**
 * The one place the oRPC surface DIFFERS from the Hono surface, deliberately.
 *
 * Hono returns two bespoke 401 bodies (`{ valid: false, error: '…' }`). Here the
 * same outcomes become ordinary ORPCErrors → `{ error, code }`, like everything
 * else. This normalises the codebase's only non-uniform wire contract.
 *
 * Safe: the frontend's session-token Path 0 reads `errorData.error` on !ok and
 * `verifyData.valid` on ok — it never reads `valid` out of a 401 body. Verified
 * by reading the route, not assumed.
 *
 * The 200 `{ valid: false }` case (hash mismatch) is preserved as-is on BOTH
 * surfaces — that one is load-bearing.
 */
const verifyApiKey = pub
  .route({ method: 'POST', path: '/user-keys/verify-api-key', tags: INTERNAL })
  .input(VerifyApiKeySchema)
  .output(VerifyApiKeyOutput)
  .handler(async ({ input }) => {
    const outcome = await userKeysService.verifyApiKey(input);
    switch (outcome.kind) {
      case 'invalid_format':
        throw new ApiError(401, 'INVALID_API_KEY_FORMAT', 'Invalid format');
      case 'no_key_configured':
        throw new ApiError(401, 'NO_API_KEY_CONFIGURED', 'No API key configured');
      case 'checked':
        return {
          valid: outcome.valid,
          account_id: outcome.account_id,
          network: outcome.network,
        };
    }
  });

// ────────────────────────────────────────────────
// key-management
// ────────────────────────────────────────────────

const generateKey = pub
  .route({ method: 'POST', path: '/key-management/generate_key', tags: INTERNAL })
  .input(GenerateKeySchema)
  .output(GenerateKeyOutput)
  .handler(({ input }) => keyMgmtService.generateGroupKey(input));

const getKey = pub
  .route({ method: 'POST', path: '/key-management/get_key', tags: INTERNAL })
  .input(GetKeySchema)
  .output(GetKeyOutput)
  .handler(({ input }) => keyMgmtService.getGroupKey(input));

const revokeMember = pub
  .route({ method: 'POST', path: '/key-management/revoke_member', tags: INTERNAL })
  .input(RevokeMemberSchema)
  .output(RevokeMemberOutput)
  .handler(({ input }) => keyMgmtService.revokeMember(input));

const rotateKey = pub
  .route({ method: 'POST', path: '/key-management/rotate_key', tags: INTERNAL })
  .input(RotateKeySchema)
  .output(RotateKeyOutput)
  .handler(({ input }) => keyMgmtService.rotateGroupKey(input));

// ────────────────────────────────────────────────

export const router = {
  userKeys: { store, retrieve, check, generateApiKey, hasApiKey, verifyApiKey },
  keyManagement: { generateKey, getKey, revokeMember, rotateKey },
};

export type Router = typeof router;

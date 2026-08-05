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
import { pub, storeLimited, walletPub } from './base.js';
import { StoreSchema, RetrieveSchema, CheckSchema, ApiKeyLookupSchema, VerifyApiKeySchema, GenerateKeySchema, GetKeySchema, RotateKeySchema, StoreOutput, RetrieveOutput, CheckOutput, GenerateApiKeyOutput, HasApiKeyOutput, RotateApiKeyOutput, VerifyApiKeyOutput, GenerateKeyOutput, GetKeyOutput, RotateKeyOutput, PrepareFileUploadSchema, FinalizeFileUploadSchema, RetrieveFileSchema, PrepareFileUploadOutput, FinalizeFileUploadOutput, RetrieveFileOutput, } from '../lib/schemas.js';
import * as userKeysService from '../lib/services/user-keys.js';
import * as keyMgmtService from '../lib/services/key-management.js';
import { ApiError } from '../lib/errors.js';
import { WalletNonceSchema, WalletVerifySchema, WalletNonceOutput, WalletVerifyOutput, } from '../lib/schemas.js';
import { issueWalletNonce, verifyWalletSignin } from '../lib/auth.js';
import * as fastfsService from '../lib/services/fastfs-storage.js';
const INTERNAL = ['internal'];
// ────────────────────────────────────────────────
// user-keys
// ────────────────────────────────────────────────
const store = storeLimited
    .route({
    method: 'POST',
    path: '/user-keys/store',
    tags: INTERNAL,
    summary: 'Store a user keypair (encrypted) in KV',
})
    .input(StoreSchema)
    .output(StoreOutput)
    .handler(({ input }) => userKeysService.storeUserKey(input));
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
const rotateApiKey = pub
    .route({
    method: 'POST',
    path: '/user-keys/rotate-api-key',
    tags: INTERNAL,
    summary: 'Rotate the API key — invalidates the previous key',
})
    .input(ApiKeyLookupSchema)
    .output(RotateApiKeyOutput)
    .handler(({ input }) => userKeysService.rotateApiKey(input));
const prepareFileUpload = pub
    .route({ method: 'POST', path: '/fastfs/prepare_upload', tags: INTERNAL })
    .input(PrepareFileUploadSchema)
    .output(PrepareFileUploadOutput)
    .handler(({ input }) => fastfsService.prepareFileUpload(input));
const finalizeFileUpload = pub
    .route({ method: 'POST', path: '/fastfs/finalize_upload', tags: INTERNAL })
    .input(FinalizeFileUploadSchema)
    .output(FinalizeFileUploadOutput)
    .handler(({ input }) => fastfsService.finalizeFileUpload(input));
const retrieveFile = pub
    .route({ method: 'POST', path: '/fastfs/retrieve', tags: INTERNAL })
    .input(RetrieveFileSchema)
    .output(RetrieveFileOutput)
    .handler(({ input }) => fastfsService.retrieveFile(input));
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
const rotateKey = pub
    .route({ method: 'POST', path: '/key-management/rotate_key', tags: INTERNAL })
    .input(RotateKeySchema)
    .output(RotateKeyOutput)
    .handler(({ input }) => keyMgmtService.rotateGroupKey(input));
// ────────────────────────────────────────────────
// ────────────────────────────────────────────────
// wallet SIWN (NEP-413 self-custody) — §5.11-A
// walletPub = gated + seedless (see rpc/base.ts).
// ────────────────────────────────────────────────
const walletNonce = walletPub
    .route({
    method: 'POST',
    path: '/wallet/nonce',
    tags: INTERNAL,
    summary: 'Issue a server-side NEP-413 nonce for wallet sign-in',
})
    .input(WalletNonceSchema)
    .output(WalletNonceOutput)
    .handler(() => ({ nonce: issueWalletNonce() }));
const walletVerify = walletPub
    .route({
    method: 'POST',
    path: '/wallet/verify',
    tags: INTERNAL,
    summary: 'Verify a NEP-413 wallet signature; returns the authenticated account',
})
    .input(WalletVerifySchema)
    .output(WalletVerifyOutput)
    .handler(async ({ input }) => {
    const result = await verifyWalletSignin(input.signed_message, input.message, input.nonce);
    if (!result.ok) {
        const message = result.code === 'UNAUTHORIZED_NONCE_REPLAY'
            ? 'Invalid or expired nonce'
            : 'Wallet signature verification failed';
        throw new ApiError(401, result.code, message);
    }
    return { account_id: result.account_id, public_key: result.public_key };
});
export const router = {
    userKeys: { store, retrieve, check, generateApiKey, hasApiKey, verifyApiKey, rotateApiKey },
    keyManagement: { generateKey, getKey, rotateKey },
    fastfs: { prepareUpload: prepareFileUpload, finalizeUpload: finalizeFileUpload, retrieve: retrieveFile },
    wallet: { nonce: walletNonce, verify: walletVerify },
};

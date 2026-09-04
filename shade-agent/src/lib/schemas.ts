// shade-agent/src/lib/schemas.ts
//
// Zod schemas for every route body, plus the `validate` middleware.
//
// DESIGN RULE — the thing that keeps this safe:
//   Each schema encodes EXACTLY what the handler already enforced inline. Not
//   one constraint more. Every route here is permissively branchy (/retrieve
//   accepts {account_id} OR {email,auth_token} OR {wallet_id}; /generate-api-key
//   has three entry shapes). A schema that looks "more correct" but is stricter
//   than reality would 400 requests that work in production today.
//
//   So: fields are optional unless the handler required them, and the only
//   value-level constraints are the ones the handler already applied
//   (ed25519: prefix, network enum, …). Those inline checks are then DELETED —
//   Zod owns them now, in one place.
//
//   The BRANCH logic (`if (account_id && !email && !auth_token)`) deliberately
//   STAYS in the handlers. Modelling it as a discriminated union would be
//   prettier and is exactly how you'd introduce a regression.
//
// ORDER (roadmap §4 says "before any auth logic", read carefully):
//   internal gate → seed init → Zod → user auth → handler
//   The X-Internal-Auth gate stays OUTERMOST. It is transport auth, not request
//   auth; putting Zod ahead of it would let an unauthenticated caller probe route
//   schemas by diffing responses to malformed vs well-formed bodies.

import { z } from 'zod';
import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from './errors.js';

// Hono env: `validate` stashes the parsed body here.
export type ValidatedEnv = { Variables: { body: unknown } };

/** Typed accessor — avoids an `as` cast at every call site. */
export function body<T extends z.ZodTypeAny>(
  c: Context<ValidatedEnv>,
  _schema: T,
): z.infer<T> {
  return c.get('body') as z.infer<T>;
}

/**
 * Parse + validate the JSON body, or throw ApiError(400).
 *
 * Note: a missing/malformed body previously threw inside the handler's try/catch
 * and surfaced as a 500 ("Failed to retrieve key"). It is now a 400 with a
 * useful message. No production caller sends an empty body — MCP and the
 * frontend always send JSON — so this only affects malformed requests, which
 * were already failing.
 */
export function validate<T extends z.ZodTypeAny>(schema: T): MiddlewareHandler<ValidatedEnv> {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'Invalid request body',
        result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }

    c.set('body', result.data);
    await next();
  };
}

// ════════════════════════════════════════════════════════════════════════════
// user-keys.ts
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /store — inline checks this replaces:
 *   if (!email || !account_id || !private_key || !public_key || !network) → 400
 *   if (!private_key.startsWith('ed25519:'))                             → 400
 *   if (!['testnet','mainnet'].includes(network))                        → 400
 *
 * KNOWN ORDERING CHANGE (accepted, disabled path): previously a request with a
 * wallet_id AND a malformed private_key hit the wallet branch first and got 501.
 * Now Zod rejects it with 400 before the handler runs. Both are rejections; the
 * wallet path is disabled either way.
 */
export const StoreSchema = z.object({
  email: z.string().min(1),
  account_id: z.string().min(1),
  private_key: z.string().startsWith('ed25519:', 'Invalid private key format'),
  public_key: z.string().min(1),
  network: z.enum(['testnet', 'mainnet']),
  auth_token: z.string().optional(),
  wallet_id: z.string().optional(),
});

/** POST /retrieve — every field optional; the handler branches on which are present. */
export const RetrieveSchema = z.object({
  email: z.string().optional(),
  auth_token: z.string().optional(),
  account_id: z.string().optional(),
  wallet_id: z.string().optional(),
});

/** POST /check — every field optional. */
export const CheckSchema = z.object({
  email: z.string().optional(),
  auth_token: z.string().optional(),
  wallet_id: z.string().optional(),
  account_id: z.string().optional(),
});

/**
 * POST /generate-api-key, /rotate-api-key, /has-api-key — same shape, all optional.
 *
 * `session_token` (§5.11-A wallet path): a verified nova_session whose `sub` is
 * `wallet|<account>`. The handler (resolveApiKeyTarget) verifies its HMAC and
 * derives the account from the signed claim — NEVER from a bare `account_id`
 * body field (that stays the disabled Fix E/F branch). All optional so the three
 * existing entry shapes are unchanged.
 */
export const ApiKeyLookupSchema = z.object({
  email: z.string().optional(),
  auth_token: z.string().optional(),
  account_id: z.string().optional(),
  wallet_id: z.string().optional(),
  session_token: z.string().optional(),
});

/**
 * POST /verify-api-key — inline check this replaces:
 *   if (!api_key || !account_id) → 400 'Missing fields'
 *
 * NOT moved into Zod: the `nova_sk_` prefix / length check. It returns a bespoke
 * shape — 401 with { valid: false, error: 'Invalid format' } — which the
 * frontend's session-token Path 0 depends on. It stays inline in the handler.
 */
export const VerifyApiKeySchema = z.object({
  api_key: z.string().min(1),
  account_id: z.string().min(1),
});

// ════════════════════════════════════════════════════════════════════════════
// key-management.ts
// ════════════════════════════════════════════════════════════════════════════

/** POST /generate_key — inline: if (!group_id) → 400 */
export const GenerateKeySchema = z.object({
  group_id: z.string().min(1),
  owner: z.string().optional(),
  contract_id: z.string().optional(),
});

/** POST /get_key — inline: if (!group_id) → 400. token/account_id are the two auth branches. */
export const GetKeySchema = z.object({
  group_id: z.string().min(1),
  token: z.string().optional(),
  account_id: z.string().optional(),
  contract_id: z.string().optional(),
});

/** POST /rotate_key — inline: if (!group_id) → 400 */
export const RotateKeySchema = z.object({
  group_id: z.string().min(1),
  contract_id: z.string().optional(),
});

// ── fastfs-storage.ts ──

/** POST /fastfs/prepare_upload — group + the two auth branches (token | account_id). */
export const PrepareFileUploadSchema = z.object({
  group_id: z.string().min(1),
  token: z.string().optional(),
  account_id: z.string().optional(),
  contract_id: z.string().optional(),
});

/** POST /fastfs/finalize_upload — the fixed file_ref, the v1 ciphertext, the SDK's format. */
export const FinalizeFileUploadSchema = z.object({
  group_id: z.string().min(1),
  file_ref: z.string().min(1),
  encrypted_b64: z.string().min(1),
  format: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** POST /fastfs/retrieve — the FastFS location + the two auth branches. */
export const RetrieveFileSchema = z.object({
  group_id: z.string().min(1),
  location: z.string().min(1),
  token: z.string().optional(),
  account_id: z.string().optional(),
  contract_id: z.string().optional(),
});

// ── retention registry (§6.1) ──

/**
 * POST /retention/register and /retention/deregister — same one-field shape.
 * The off-chain expiry driver needs a candidate list of groups with a retention
 * window because the contract's retention_windows LookupMap is not iterable.
 * register is called registry-FIRST by MCP's set_group_retention (before the
 * on-chain set); deregister is best-effort on a window clear.
 */
export const RetentionRegisterSchema = z.object({
  group_id: z.string().min(1),
});

/** POST /retention/scan — read-only dry-run; optional contract override. */
export const RetentionScanSchema = z.object({
  contract_id: z.string().optional(),
});

/**
 * POST /retention/execute — the IRREVERSIBLE destroy path (per group).
 * `confirm` defaults to false: without it, execute returns the PLAN and destroys
 * nothing (dry-run echo). Only { confirm: true } actually deletes. `confirm` is
 * optional so a bare call is a safe dry-run, never an accidental deletion.
 */
export const RetentionExecuteSchema = z.object({
  group_id: z.string().min(1),
  confirm: z.boolean().optional(),
  contract_id: z.string().optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// OUTPUT SCHEMAS (oRPC)
// ════════════════════════════════════════════════════════════════════════════
//
// These describe what each service RETURNS. The Hono routes never needed them;
// oRPC uses them to (a) type the handler's return value and (b) generate the
// OpenAPI spec. They must match the services EXACTLY — an output schema that is
// stricter than reality throws at runtime, on the response, after the work is done.
//
// Same rule as the input schemas: NEVER add .strict().

// ── user-keys ───────────────────────────────────────────────────────────────

export const StoreOutput = z.object({
  success: z.boolean(),
  account_id: z.string(),
  network: z.string(),
  wallet_id: z.string().nullable(),
  checksum: z.string(),
  key_id: z.string(),
});

/**
 * ⚠️  RETURNS A PRIVATE KEY. This procedure is tagged `internal` and is excluded
 * from any published OpenAPI spec (see rpc/router.ts). It exists so MCP can sign
 * on a user's behalf. Never surface it in a public contract.
 */
export const RetrieveOutput = z.object({
  account_id: z.string(),
  private_key: z.string(),
  public_key: z.string(),
  network: z.string(),
  wallet_id: z.string().nullable(),
  checksum: z.string(),
});

export const CheckOutput = z.object({
  exists: z.boolean(),
  account_id: z.string().nullable(),
});

export const GenerateApiKeyOutput = z.object({
  success: z.boolean(),
  api_key: z.string(),
  account_id: z.string(),
  version: z.number(),
  message: z.string(),
});

export const RotateApiKeyOutput = z.object({
  success: z.boolean(),
  api_key: z.string(),
  account_id: z.string(),
  version: z.number(),
  message: z.string(),
});

export const HasApiKeyOutput = z.object({
  has_api_key: z.boolean(),
  account_id: z.string(),
});

/**
 * Only the 200 case. The Hono route's two 401 shapes
 * (`{ valid: false, error: 'Invalid format' }` / `'No API key configured'`)
 * become ORPCErrors on the oRPC surface — i.e. `{ error, code }`, like every
 * other error. This NORMALISES the one non-uniform wire contract in the codebase.
 * Safe: the frontend's session-token Path 0 reads `errorData.error` on !ok and
 * `verifyData.valid` on ok, so it never reads `valid` from a 401 body.
 * The Hono surface keeps the old bytes until consumers are flipped (step 6.4).
 */
export const VerifyApiKeyOutput = z.object({
  valid: z.boolean(),
  account_id: z.string(),
  network: z.string(),
});

// ── key-management ──────────────────────────────────────────────────────────

export const GenerateKeyOutput = z.object({
  key: z.string(),
  checksum: z.string(),
});

export const GetKeyOutput = z.object({
  key: z.string(),
  checksum: z.string(),
});

export const RevokeMemberOutput = z.object({
  success: z.boolean(),
  group_id: z.string(),
  revoked_user_id: z.string(),
  version: z.number(),
  message: z.string(),
});

export const RotateKeyOutput = z.object({
  success: z.boolean(),
  new_key_hash: z.string(),
  version: z.number(),
  checksum: z.string(),
});

// ── fastfs-storage ──

export const PrepareFileUploadOutput = z.object({
  file_key: z.string(),
  file_ref: z.string(),
  version: z.string(),
});

export const FinalizeFileUploadOutput = z.object({
  location: z.string(),
  backend: z.string(),
});

export const RetrieveFileOutput = z.object({
  file_key: z.string(),
  encrypted_b64: z.string(),
  location: z.string(),
  group_id: z.string(),
  format: z.record(z.string(), z.unknown()).nullable(),
});

// ── retention registry ──
// register and deregister share this shape; the optional booleans distinguish
// which operation ran (registered/already_present vs deregistered/was_present).
export const RetentionRegisterOutput = z.object({
  registered: z.boolean().optional(),
  deregistered: z.boolean().optional(),
  already_present: z.boolean().optional(),
  was_present: z.boolean().optional(),
  size: z.number(),
});

// §6.1 scan (read-only). Mirrors ScanResult / ScanGroupResult from the service.
export const RetentionScanOutput = z.object({
  scanned_at: z.string(),
  registry_size: z.number(),
  total_expired: z.number(),
  groups: z.array(z.object({
    group_id: z.string(),
    retention_days: z.number().nullable(),
    expired_trans_ids: z.array(z.string()),
    skipped_reason: z.string().optional(),
    error: z.string().optional(),
  })),
});

// §6.1/§6.2 execute (irreversible). Mirrors ExecuteResult / ExecuteFileResult.
// confirmed:false ⇒ dry-run (destroyed_count 0, all results destroyed:false).
// destroyed:true + bookkeeping_incomplete:true ⇒ key shredded (data gone) but a
// later step failed; re-run finishes the audit tombstone (data-centric Q3).
export const RetentionExecuteOutput = z.object({
  group_id: z.string(),
  confirmed: z.boolean(),
  candidates: z.number(),
  destroyed_count: z.number(),
  results: z.array(z.object({
    trans_id: z.string(),
    location: z.string(),
    destroyed: z.boolean(),
    bookkeeping_incomplete: z.boolean().optional(),
    error: z.string().optional(),
  })),
});

// ── wallet SIWN inputs ───────────────────────────────────────────────────────

/**
 * POST /wallet/nonce — no request body. The route mints a server-issued nonce.
 * An empty object accepts `{}`; Zod's default strip drops any stray key a proxy
 * adds (same mechanism the other routes rely on), so this can't 400 on extras.
 */
export const WalletNonceSchema = z.object({});

/**
 * POST /wallet/verify — the wallet's NEP-413 output, the echoed message, and the
 * Shade-issued nonce. `signed_message` is near-kit's SignedMessage.
 *
 * Unlike the branchy user-keys routes, this route has exactly ONE entry shape,
 * so the schema requires its fields (a missing one is a malformed wallet
 * response, not an alternate auth path). near-kit's optional `state` (CSRF, for
 * browser wallets) is declared optional so a wallet returning it doesn't 400;
 * default strip drops anything else.
 */
export const WalletVerifySchema = z.object({
  signed_message: z.object({
    accountId: z.string().min(1),
    publicKey: z.string().min(1),
    signature: z.string().min(1),
    state: z.string().optional(),
  }),
  message: z.string().min(1),
  nonce: z.string().regex(/^[0-9a-f]{64}$/i, 'nonce must be 32-byte hex'),
});

// ── wallet SIWN outputs ──────────────────────────────────────────────────────

/** /wallet/nonce success — the 32-byte server-issued nonce, hex. */
export const WalletNonceOutput = z.object({
  nonce: z.string(),
});

/**
 * /wallet/verify success — the authenticated NEAR account and the full-access
 * key that signed. Failure never reaches here: it throws ApiError
 * (UNAUTHORIZED_NONCE_REPLAY / UNAUTHORIZED), shaped to { error, code } by
 * rpc/base.ts's mapErrors.
 */
export const WalletVerifyOutput = z.object({
  account_id: z.string(),
  public_key: z.string(),
});
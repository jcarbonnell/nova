// shade-agent/src/routes/user-keys.ts - user key management with KV persistence and deterministic derivation
//
// THIN HTTP ADAPTER. All logic lives in lib/services/user-keys.ts.
// This file owns only HTTP concerns:
//   - the X-Internal-Auth gate (transport auth — OUTERMOST, fails closed)
//   - master-seed initialization
//   - Zod validation
//   - rate limiting (keyed by IP — a header concern, so it cannot live in a service)
//   - mapping service results / ApiError to responses
//
// MIDDLEWARE ORDER IS LOAD-BEARING: gate → seed → Zod → (user auth, inside the
// service) → handler. The gate must stay outermost; putting Zod ahead of it
// would let an unauthenticated caller probe route schemas by diffing responses
// to malformed vs well-formed bodies.

import { Hono } from 'hono';

import { initializeMasterSeed } from '../lib/seed.js';
import { checkInternalAuth } from '../lib/auth.js';
import { getAttestation } from '../lib/attestation.js';
import { ApiError, errorHandler } from '../lib/errors.js';
import {
  validate, body, type ValidatedEnv,
  StoreSchema, RetrieveSchema, CheckSchema, ApiKeyLookupSchema, VerifyApiKeySchema,
} from '../lib/schemas.js';
import {
  storeUserKey,
  retrieveUserKey,
  checkAccount,
  generateApiKey,
  hasApiKey,
  verifyApiKey,
} from '../lib/services/user-keys.js';

// ────────────────────────────────────────────────
// Rate limiting (HTTP concern — stays here)
// ────────────────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ────────────────────────────────────────────────
// Router
// ────────────────────────────────────────────────

const userKeys = new Hono<ValidatedEnv>();
userKeys.onError(errorHandler);

// Internal gate (v0.3.2 Fix 3). Health is exempt so liveness probes work.
userKeys.use('*', async (c, next) => {
  const p = c.req.path;
  if (c.req.method === 'GET' && (p === '/api/user-keys' || p === '/api/user-keys/')) {
    return next();
  }
  if (!checkInternalAuth(c.req.header('x-internal-auth'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

// Env validation (once) + master seed (idempotent).
let envValidated = false;
userKeys.use('*', async (c, next) => {
  if (!envValidated) {
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const SHADE_AGENT_ACCOUNT_ID = process.env.SHADE_AGENT_ACCOUNT_ID;
    const TEE_SECRET = process.env.TEE_KEY_SECRET || '';

    if (!AUTH0_DOMAIN) throw new Error('AUTH0_DOMAIN required');
    if (!SHADE_AGENT_ACCOUNT_ID) throw new Error('SHADE_AGENT_ACCOUNT_ID required');
    if (!/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
      throw new Error('TEE_KEY_SECRET must be a 64-char hex string (32 bytes)');
    }
    envValidated = true;
  }
  await initializeMasterSeed();
  await next();
});

// ────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────

userKeys.post('/store', validate(StoreSchema), async (c) => {
  const clientIp = c.req.header('x-forwarded-for') ?? 'unknown';
  if (!checkRateLimit(clientIp)) {
    throw new ApiError(429, 'RATE_LIMITED', 'Rate limit exceeded — max 10 store requests per minute');
  }
  return c.json(await storeUserKey(body(c, StoreSchema)));
});

userKeys.post('/retrieve', validate(RetrieveSchema), async (c) =>
  c.json(await retrieveUserKey(body(c, RetrieveSchema))));

userKeys.post('/check', validate(CheckSchema), async (c) =>
  c.json(await checkAccount(body(c, CheckSchema))));

userKeys.post('/generate-api-key', validate(ApiKeyLookupSchema), async (c) =>
  c.json(await generateApiKey(body(c, ApiKeyLookupSchema))));

userKeys.post('/has-api-key', validate(ApiKeyLookupSchema), async (c) =>
  c.json(await hasApiKey(body(c, ApiKeyLookupSchema))));

// VERIFY API KEY — the one non-uniform wire contract in the codebase.
// The service returns a domain outcome; the mapping below reproduces today's
// exact bytes. Note the third case: a hash MISMATCH is 200 { valid: false },
// NOT 401. The frontend's session-token Path 0 branches on `ok` first, then on
// `valid` — so this distinction matters.
userKeys.post('/verify-api-key', validate(VerifyApiKeySchema), async (c) => {
  const outcome = await verifyApiKey(body(c, VerifyApiKeySchema));
  switch (outcome.kind) {
    case 'invalid_format':
      return c.json({ valid: false, error: 'Invalid format' }, 401);
    case 'no_key_configured':
      return c.json({ valid: false, error: 'No API key configured' }, 401);
    case 'checked':
      return c.json({
        valid: outcome.valid,
        account_id: outcome.account_id,
        network: outcome.network,
      });
  }
});

// Health — exempt from the gate. Seed is already initialized by the middleware above.
userKeys.get('/', async (c) => {
  const attestation = await getAttestation();
  return c.json({
    status: 'healthy',
    service: 'user-account-keys',
    attestation: attestation.provider,
    attestation_pcr0: attestation.pcr0,
    attestation_verified: attestation.verified,
    auth: 'Auth0 JWT verified (idToken or accessToken)',
    master_seed_status: 'initialized',
  });
});

export default userKeys;
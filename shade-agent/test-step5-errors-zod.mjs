// test-step5-errors-zod.mjs — harness for v0.4 Step 5 (ApiError + Zod).
//
// Three things to prove, in order of how badly they'd hurt:
//
//   1. NO REAL PAYLOAD IS REJECTED. Every route here is permissively branchy. A
//      schema that is stricter than the code it replaces would 400 requests that
//      work in production today. The payloads below are transcribed verbatim from
//      the actual call sites in mcp-server/server.py and nova-landing's auth routes.
//
//   2. WIRE FORMAT UNCHANGED. `error` must stay a TOP-LEVEL STRING — the frontend
//      does `errorData.error || 'Invalid API key'`. Nest it and every error path
//      renders "[object Object]".
//
//   3. MIDDLEWARE ORDER. internal gate → seed → Zod → user auth. The X-Internal-Auth
//      gate must stay OUTERMOST: a caller without the secret must get 403 even when
//      the body is malformed, or they can probe route schemas by diffing responses.
//
// Runs fully in-process against the REAL compiled routers via Hono's app.request().
// No network: we pre-seed the master seed so initializeMasterSeed() short-circuits,
// and every assertion below short-circuits before any handler touches KV or Auth0.
//
// Usage, from shade-agent/:
//     npm run build
//     node ../test-step5-errors-zod.mjs

import path from 'path';
import { pathToFileURL } from 'url';
import crypto from 'crypto';

const INTERNAL_SECRET = 'c'.repeat(64);
process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
process.env.TEE_KEY_SECRET = 'b'.repeat(64);
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.SHADE_AGENT_ACCOUNT_ID = 'test-agent';

const imp = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href);

let cryptoLib, schemas, userKeys, keyMgmt, errors;
try {
  cryptoLib = await imp('./dist/lib/crypto.js');
  schemas   = await imp('./dist/lib/schemas.js');
  errors    = await imp('./dist/lib/errors.js');
  userKeys  = (await imp('./dist/routes/user-keys.js')).default;
  keyMgmt   = (await imp('./dist/routes/key-management.js')).default;
} catch (e) {
  console.error('FATAL: could not import compiled output. Run `npm run build` in shade-agent/ first.');
  console.error(e.message);
  process.exit(2);
}

// Pre-seed so initializeMasterSeed() returns early and never calls KV.
cryptoLib.setMasterSeed(new Uint8Array(crypto.createHash('sha256').update('step5-test-seed').digest()));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? '\n         ' + extra : ''}`);
  cond ? pass++ : fail++;
};

// ══════════════════════════════════════════════════════════════════════════════
// 1. Real payloads must ALL validate. Transcribed from the actual call sites.
// ══════════════════════════════════════════════════════════════════════════════
console.log('── 1. Real caller payloads (schema level) ──────────────────────────\n');

const REAL = [
  [schemas.StoreSchema, 'frontend create-account → /store', {
    email: 'a@b.com', account_id: 'x.nova-sdk.near',
    private_key: 'ed25519:' + 'K'.repeat(80), public_key: 'ed25519:' + 'P'.repeat(40),
    network: 'mainnet', auth_token: 'eyJhbGciOi...' }],
  [schemas.RetrieveSchema, 'MCP get_user_signer → /retrieve (ACCOUNT-ONLY)', {
    account_id: 'gmail-14.nova-sdk.near' }],
  [schemas.RetrieveSchema, 'frontend retrieve-key → /retrieve (email)', {
    email: 'a@b.com', auth_token: 'eyJ...', account_id: 'x.nova-sdk.near' }],
  [schemas.CheckSchema, 'frontend session-token → /check', {
    email: 'a@b.com', auth_token: 'eyJ...' }],
  [schemas.CheckSchema, 'frontend check-for-account → /check (NO auth_token)', {
    email: 'a@b.com' }],
  [schemas.ApiKeyLookupSchema, 'frontend → /generate-api-key', {
    email: 'a@b.com', auth_token: 'eyJ...' }],
  [schemas.VerifyApiKeySchema, 'frontend session-token Path 0 → /verify-api-key', {
    api_key: 'nova_sk_abc123', account_id: 'x.nova-sdk.near' }],
  [schemas.GetKeySchema, 'MCP _get_shade_key_internal → /get_key', {
    group_id: 'g', account_id: 'x.nova-sdk.near', contract_id: 'nova-sdk.near' }],
  // NOTE: MCP sends an EXTRA account_id here that the schema does not declare.
  // Zod strips unknown keys by default. NEVER add .strict() to these schemas.
  [schemas.GenerateKeySchema, 'MCP register_group → /generate_key (extra key stripped)', {
    group_id: 'g', owner: 'x.nova-sdk.near', account_id: 'x.nova-sdk.near' }],
  [schemas.RevokeMemberSchema, 'MCP revoke_group_member → /revoke_member', {
    group_id: 'g', user_id: 'y.nova-sdk.near', contract_id: 'nova-sdk.near' }],
];

for (const [schema, name, payload] of REAL) {
  const r = schema.safeParse(payload);
  check(name + ' accepted', r.success,
    r.success ? '' : JSON.stringify(r.error.issues));
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. Schemas must still reject what the inline code rejected — no more, no less.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Rejections the inline code already made ──────────────────────\n');

const REJECT = [
  [schemas.StoreSchema, '/store missing required field (account_id)', {
    email: 'a@b.com', private_key: 'ed25519:x', public_key: 'p', network: 'mainnet' }],
  [schemas.StoreSchema, '/store private_key without ed25519: prefix', {
    email: 'a@b.com', account_id: 'x', private_key: 'secp256k1:x', public_key: 'p', network: 'mainnet' }],
  [schemas.StoreSchema, '/store invalid network', {
    email: 'a@b.com', account_id: 'x', private_key: 'ed25519:x', public_key: 'p', network: 'devnet' }],
  [schemas.VerifyApiKeySchema, '/verify-api-key missing account_id', { api_key: 'nova_sk_x' }],
  [schemas.GetKeySchema, '/get_key missing group_id', { account_id: 'x' }],
  [schemas.RevokeMemberSchema, '/revoke_member missing user_id', { group_id: 'g' }],
];

for (const [schema, name, payload] of REJECT) {
  check(name + ' rejected', !schema.safeParse(payload).success);
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. Live router: middleware order + wire format.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. Live router (ordering + wire format) ─────────────────────────\n');

// Mount exactly as src/index.ts does. The routers register their routes at
// '/store', '/get_key' etc — the '/api/...' prefix comes from the mount. The
// gate middleware also matches on the FULL mounted path (it exempts
// '/api/user-keys'), so calling the routers directly would not reproduce
// production behaviour.
const { Hono: HonoCtor } = await import('hono');
const app = new HonoCtor();
app.route('/api/user-keys', userKeys);
app.route('/api/key-management', keyMgmt);

const post = (path, body, headers = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const GATE = { 'x-internal-auth': INTERNAL_SECRET };

// ORDER: the gate is outermost. A malformed body WITHOUT the secret must still
// be a 403 — never a 400 — or schemas become probeable by unauthenticated callers.
{
  const res = await post('/api/user-keys/store', { garbage: true });
  check('gate is OUTERMOST: malformed body + no secret → 403, not 400',
    res.status === 403, `got ${res.status}`);
}

// With the gate satisfied, a malformed body is a 400 VALIDATION_FAILED.
{
  const res = await post('/api/user-keys/store', { email: 'a@b.com' }, GATE);
  const b = await res.json();
  check('gate passed + malformed body → 400', res.status === 400, `got ${res.status}`);
  check('  error code is VALIDATION_FAILED', b.code === 'VALIDATION_FAILED', JSON.stringify(b));
  check('  WIRE FORMAT: `error` is a top-level STRING (frontend reads it raw)',
    typeof b.error === 'string', `typeof error = ${typeof b.error}`);
  check('  details lists the offending fields', Array.isArray(b.details) && b.details.length > 0);
}

// Non-JSON body → 400 INVALID_JSON, not a 500.
{
  const res = await app.request('/api/user-keys/retrieve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...GATE }, body: 'not json',
  });
  const b = await res.json();
  check('non-JSON body → 400 INVALID_JSON (was: 500)',
    res.status === 400 && b.code === 'INVALID_JSON', `${res.status} ${JSON.stringify(b)}`);
}

// key-management router: same gate, same shape.
{
  const res = await post('/api/key-management/get_key', { nope: 1 }, GATE);
  const b = await res.json();
  check('key-management: malformed body → 400 VALIDATION_FAILED',
    res.status === 400 && b.code === 'VALIDATION_FAILED', `${res.status} ${JSON.stringify(b)}`);
  check('  key-management wire format: `error` is a string', typeof b.error === 'string');
}

// Health endpoints stay exempt from the gate (Fix 3 regression guard).
{
  const res = await app.request('/api/user-keys', { method: 'GET' });
  check('health endpoint still exempt from the internal gate', res.status !== 403, `got ${res.status}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. errorHandler: unhandled exceptions must NOT leak their internals.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. Internal-leak guard ──────────────────────────────────────────\n');

{
  const { Hono } = await import('hono');
  const app = new Hono();
  app.onError(errors.errorHandler);

  const SECRET_TEXT = 'TEE_KEY_SECRET must be a 64-char hex string';
  app.get('/boom', () => { throw new Error(SECRET_TEXT); });
  app.get('/expected', () => { throw new errors.ApiError(403, 'UNAUTHORIZED', 'Unauthorized'); });

  const r1 = await app.request('/boom');
  const b1 = await r1.json();
  check('unhandled error → 500 with opaque body',
    r1.status === 500 && b1.code === 'INTERNAL', JSON.stringify(b1));
  check('  internal message NOT leaked to the caller',
    !JSON.stringify(b1).includes('TEE_KEY_SECRET'), JSON.stringify(b1));

  const r2 = await app.request('/expected');
  const b2 = await r2.json();
  check('ApiError → declared status + code + string message',
    r2.status === 403 && b2.code === 'UNAUTHORIZED' && b2.error === 'Unauthorized',
    JSON.stringify(b2));
}

console.log('\n' + '='.repeat(72));
if (fail === 0) {
  console.log(`ALL ${pass} CHECKS PASSED — no real payload rejected, wire format intact, gate outermost.`);
  process.exit(0);
} else {
  console.log(`${fail}/${pass + fail} FAILED — DO NOT DEPLOY.`);
  process.exit(1);
}
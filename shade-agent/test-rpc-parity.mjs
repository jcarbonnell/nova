// test-rpc-parity.mjs — harness for v0.4 step 6.2 (oRPC strangler mount).
//
// The oRPC procedures and the Hono routes are two adapters over the SAME
// services, so parity should hold by construction. This proves it — and proves
// the security invariants survived the move to a different middleware system.
//
// THREE THINGS THAT COULD SILENTLY BREAK, in order of severity:
//
//   1. GATE ORDERING. Our gate is now oRPC middleware, not Hono middleware. If
//      oRPC validates the request body BEFORE running middleware, then a
//      malformed body with no secret returns 400 instead of 403 — leaking the
//      route's schema shape to unauthenticated callers. We have held "gate is
//      outermost" since v0.3.2 Fix 3. Section 1 asserts it on both surfaces.
//
//   2. WIRE FORMAT. oRPC's default error body is
//      { defined, code, status, message, data }. Ours is { error: <string>, code }.
//      The frontend does `errorData.error || '…'` — a nested/absent `error`
//      renders "[object Object]" in every error path. Section 3 asserts the
//      customErrorResponseBodyEncoder is actually in effect.
//
//   3. STATUS/BODY DRIFT between the two surfaces. Section 2 sends identical
//      payloads to both and diffs the results.
//
// SCOPE: only request paths that short-circuit BEFORE any network call are
// covered here (gate, validation, the wallet-501 branches, auth-required
// branches, verify-api-key's format check, get_key's auth check). Paths that hit
// KV/Auth0/NEAR cannot run in-process; their parity is structural (identical
// service function) and is verified against production after deploy.
//
// Run from shade-agent/:
//     npm run build
//     node test-rpc-parity.mjs

import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';

const INTERNAL_SECRET = 'd'.repeat(64);
process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
process.env.TEE_KEY_SECRET = 'b'.repeat(64);
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.SHADE_AGENT_ACCOUNT_ID = 'test-agent';

const imp = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href);

let cryptoLib, userKeys, keyMgmt, mount, Hono;
try {
  cryptoLib = await imp('./dist/lib/crypto.js');
  userKeys = (await imp('./dist/routes/user-keys.js')).default;
  keyMgmt = (await imp('./dist/routes/key-management.js')).default;
  mount = await imp('./dist/rpc/mount.js');
  ({ Hono } = await import('hono'));
} catch (e) {
  console.error('FATAL: could not import compiled output. Run `npm run build` first.');
  console.error(e);
  process.exit(2);
}

// Pre-seed so initializeMasterSeed() short-circuits and never touches KV.
cryptoLib.setMasterSeed(new Uint8Array(crypto.createHash('sha256').update('parity-seed').digest()));

// Mount BOTH surfaces exactly as src/index.ts does.
const app = new Hono();
mount.mountRpc(app);
app.route('/api/user-keys', userKeys);
app.route('/api/key-management', keyMgmt);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? '\n         ' + extra : ''}`);
  cond ? pass++ : fail++;
};

const GATE = { 'x-internal-auth': INTERNAL_SECRET };

const post = (p, body, headers = {}) =>
  app.request(p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function read(res) {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// The 10 endpoints, legacy path <-> rpc path.
const PAIRS = {
  store:         ['/api/user-keys/store',                   '/rpc/user-keys/store'],
  retrieve:      ['/api/user-keys/retrieve',                '/rpc/user-keys/retrieve'],
  check:         ['/api/user-keys/check',                   '/rpc/user-keys/check'],
  genApiKey:     ['/api/user-keys/generate-api-key',        '/rpc/user-keys/generate-api-key'],
  hasApiKey:     ['/api/user-keys/has-api-key',             '/rpc/user-keys/has-api-key'],
  verifyApiKey:  ['/api/user-keys/verify-api-key',          '/rpc/user-keys/verify-api-key'],
  generateKey:   ['/api/key-management/generate_key',       '/rpc/key-management/generate_key'],
  getKey:        ['/api/key-management/get_key',            '/rpc/key-management/get_key'],
  revokeMember:  ['/api/key-management/revoke_member',      '/rpc/key-management/revoke_member'],
  rotateKey:     ['/api/key-management/rotate_key',         '/rpc/key-management/rotate_key'],
};

// ══════════════════════════════════════════════════════════════════════════════
console.log('── 1. THE GATE IS OUTERMOST (on BOTH surfaces) ─────────────────────\n');
// A malformed body with NO secret must be 403 — never 400. If oRPC validates the
// body before running our gate middleware, this fails, and unauthenticated
// callers can probe route schemas by diffing responses. This is the single most
// important assertion in this file.
// ══════════════════════════════════════════════════════════════════════════════

for (const [name, [legacy, rpc]] of Object.entries(PAIRS)) {
  const l = await read(await post(legacy, { garbage: true }));
  const r = await read(await post(rpc, { garbage: true }));
  check(`${name}: malformed body + NO secret -> 403 on both (not 400)`,
    l.status === 403 && r.status === 403,
    `legacy=${l.status} rpc=${r.status}`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. PARITY: identical payload -> identical status + body ─────────\n');
// Only network-free paths. Each case exercises a real branch of a real service.
// ══════════════════════════════════════════════════════════════════════════════

const VALID_STORE = {
  email: 'a@b.com',
  account_id: 'x.nova-sdk.near',
  private_key: 'ed25519:' + 'K'.repeat(80),
  public_key: 'ed25519:' + 'P'.repeat(40),
  network: 'mainnet',
};

const CASES = [
  // wallet branches — all 501 WALLET_AUTH_PENDING_SELF_CUSTODY (v0.4 Fixes E/F/H)
  ['store: wallet_id (no auth_token) -> 501',        'store',      { ...VALID_STORE, wallet_id: 'w' }],
  ['store: no auth_token, no wallet_id -> 400',      'store',      VALID_STORE],
  ['retrieve: wallet_id -> 501',                     'retrieve',   { wallet_id: 'w' }],
  ['retrieve: empty -> 400',                         'retrieve',   {}],
  ['check: empty -> 400',                            'check',      {}],
  ['generate-api-key: bare account_id -> 501',       'genApiKey',  { account_id: 'victim.nova-sdk.near' }],
  ['generate-api-key: bare wallet_id -> 501',        'genApiKey',  { wallet_id: 'w' }],
  ['generate-api-key: empty -> 400',                 'genApiKey',  {}],
  ['has-api-key: bare account_id -> 501',            'hasApiKey',  { account_id: 'victim.nova-sdk.near' }],
  ['has-api-key: empty -> 400',                      'hasApiKey',  {}],
  // validation
  ['store: missing required fields -> 400',          'store',      { email: 'a@b.com' }],
  ['get_key: missing group_id -> 400',               'getKey',     { account_id: 'x' }],
  ['revoke_member: missing user_id -> 400',          'revokeMember', { group_id: 'g' }],
  // auth-required, pre-network
  ['get_key: group_id but no token/account -> 400',  'getKey',     { group_id: 'g' }],
];

for (const [name, key, payload] of CASES) {
  const [legacy, rpc] = PAIRS[key];
  const l = await read(await post(legacy, payload, GATE));
  const r = await read(await post(rpc, payload, GATE));

  const statusMatch = l.status === r.status;
  const codeMatch = l.body?.code === r.body?.code;
  const errorMatch = l.body?.error === r.body?.error;

  check(name,
    statusMatch && codeMatch && errorMatch,
    statusMatch && codeMatch && errorMatch
      ? `both ${l.status} ${JSON.stringify(l.body?.code ?? '')}`
      : `legacy=${l.status} ${JSON.stringify(l.body)}\n         rpc   =${r.status} ${JSON.stringify(r.body)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. WIRE FORMAT: `error` is a top-level STRING on the rpc surface ──\n');
// The frontend does `errorData.error || '…'`. If the encoder is not in effect,
// oRPC emits { defined, code, status, message, data } and every frontend error
// path renders "[object Object]".
// ══════════════════════════════════════════════════════════════════════════════

{
  const r = await read(await post(PAIRS.retrieve[1], { wallet_id: 'w' }, GATE));
  check('rpc error body has a top-level STRING `error`',
    typeof r.body?.error === 'string', `typeof error = ${typeof r.body?.error}`);
  check('rpc error body has `code`',
    typeof r.body?.code === 'string', JSON.stringify(r.body));
  check('rpc error body does NOT leak oRPC internals (defined/status/message)',
    r.body?.defined === undefined && r.body?.status === undefined && r.body?.message === undefined,
    JSON.stringify(r.body));
}

{
  // Gate rejection must be shaped like the Hono gate: { error: 'Forbidden' }.
  const r = await read(await post(PAIRS.store[1], {}, {}));
  check('rpc gate 403 body has a string `error`',
    r.status === 403 && typeof r.body?.error === 'string',
    `${r.status} ${JSON.stringify(r.body)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 4. THE ONE DELIBERATE DIVERGENCE: verify-api-key ────────────────\n');
// Hono returns bespoke 401 bodies { valid:false, error }. The rpc surface
// normalises them to { error, code }. Same STATUS; different body — on purpose.
// Safe because the frontend reads `errorData.error` on !ok and only reads
// `valid` on ok. Asserted here so the divergence is INTENTIONAL and pinned, not
// discovered later in production.
// ══════════════════════════════════════════════════════════════════════════════

{
  const payload = { api_key: 'nova_sk_short', account_id: 'x.nova-sdk.near' };
  const l = await read(await post(PAIRS.verifyApiKey[0], payload, GATE));
  const r = await read(await post(PAIRS.verifyApiKey[1], payload, GATE));

  check('verify-api-key bad format: SAME status (401) on both',
    l.status === 401 && r.status === 401, `legacy=${l.status} rpc=${r.status}`);
  check('  legacy keeps its bespoke body { valid:false, error }',
    l.body?.valid === false && l.body?.error === 'Invalid format', JSON.stringify(l.body));
  check('  rpc normalises to { error, code } (deliberate)',
    r.body?.error === 'Invalid format' && r.body?.code === 'INVALID_API_KEY_FORMAT',
    JSON.stringify(r.body));
  check('  frontend-compat: BOTH expose `error` as a string (the only field it reads on !ok)',
    typeof l.body?.error === 'string' && typeof r.body?.error === 'string');
}

console.log('\n' + '='.repeat(74));
if (fail === 0) {
  console.log(`ALL ${pass} CHECKS PASSED — gate outermost on both surfaces, wire format intact, parity holds.`);
  process.exit(0);
} else {
  console.log(`${fail}/${pass + fail} FAILED — DO NOT DEPLOY.`);
  process.exit(1);
}
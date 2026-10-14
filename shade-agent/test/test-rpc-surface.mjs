// shade-agent/test/test-rpc-surface.mjs
//
// The /rpc surface on its own: replaces the parts of test-rpc-parity.mjs that
// still apply now that the legacy Hono adapters (dist/routes/*) are gone.
// Parity with them is moot; the invariants they guarded are not:
//
//   1. GATE OUTERMOST on EVERY procedure — malformed body + no secret => 403,
//      never 400 (no schema probing by unauthenticated callers). This now
//      includes the procedures parity never covered: wallet/*, retention/*,
//      fastfs/*, rotate-api-key, and the new agent-identity/*.
//   2. WIRE FORMAT — { error: <string>, code } at top level, no oRPC internals.
//   3. agent-identity/* — happy challenge + the network-free refusal paths.
//
// SCOPE: request paths that short-circuit BEFORE any network call only.
//
// Run from shade-agent/:
//     npm run build
//     node test/test-rpc-surface.mjs

import crypto from 'crypto';
import path from 'path';
import { pathToFileURL } from 'url';

const INTERNAL_SECRET = 'd'.repeat(64);
process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
process.env.TEE_KEY_SECRET = 'b'.repeat(64);
process.env.AUTH0_DOMAIN = 'test.auth0.com';
process.env.SHADE_AGENT_ACCOUNT_ID = 'test-agent';
delete process.env.AGENT_IDENTITY_RECIPIENT; // assert the default

const imp = (p) => import(pathToFileURL(path.resolve(process.cwd(), p)).href);

let cryptoLib, mount, Hono;
try {
  cryptoLib = await imp('./dist/lib/crypto.js');
  mount = await imp('./dist/rpc/mount.js');
  ({ Hono } = await import('hono'));
} catch (e) {
  console.error('FATAL: could not import compiled output. Run `npm run build` first (from shade-agent/).');
  console.error(e);
  process.exit(2);
}

// Pre-seed so initializeMasterSeed() short-circuits and never touches KV.
cryptoLib.setMasterSeed(new Uint8Array(crypto.createHash('sha256').update('surface-seed').digest()));

const app = new Hono();
mount.mountRpc(app);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? '\n         ' + extra : ''}`);
  cond ? pass++ : fail++;
};
const GATE = { 'x-internal-auth': INTERNAL_SECRET };
const post = (p, body, headers = {}) =>
  app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function read(res) {
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// Every procedure in rpc/router.ts. If you add one there, add it here.
const ALL = [
  '/rpc/user-keys/store', '/rpc/user-keys/retrieve', '/rpc/user-keys/check',
  '/rpc/user-keys/generate-api-key', '/rpc/user-keys/has-api-key',
  '/rpc/user-keys/verify-api-key', '/rpc/user-keys/rotate-api-key',
  '/rpc/key-management/generate_key', '/rpc/key-management/get_key', '/rpc/key-management/rotate_key',
  '/rpc/fastfs/prepare_upload', '/rpc/fastfs/finalize_upload', '/rpc/fastfs/retrieve',
  '/rpc/wallet/nonce', '/rpc/wallet/verify',
  '/rpc/agent-identity/challenge', '/rpc/agent-identity/verify',
  '/rpc/retention/register', '/rpc/retention/deregister', '/rpc/retention/scan', '/rpc/retention/execute',
];

// ══════════════════════════════════════════════════════════════════════════════
console.log('── 1. THE GATE IS OUTERMOST on every procedure ─────────────────────\n');
// ══════════════════════════════════════════════════════════════════════════════
for (const p of ALL) {
  const noSecret = await read(await post(p, { garbage: true }));
  const wrongSecret = await read(await post(p, { garbage: true }, { 'x-internal-auth': 'e'.repeat(64) }));
  check(`${p}: malformed body, no / wrong secret -> 403 (not 400)`,
    noSecret.status === 403 && wrongSecret.status === 403,
    `none=${noSecret.status} wrong=${wrongSecret.status}`);
}
{
  // Guard against an inert section 1: with the secret, at least one malformed
  // body must reach validation (400) — proving 403 above came from the gate.
  const r = await read(await post('/rpc/agent-identity/verify', { garbage: true }, GATE));
  check('control: same malformed body WITH the secret -> 400 (gate is what produced the 403s)', r.status === 400, `got ${r.status}`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. WIRE FORMAT ──────────────────────────────────────────────────\n');
// ══════════════════════════════════════════════════════════════════════════════
{
  const r = await read(await post('/rpc/user-keys/retrieve', { wallet_id: 'w' }, GATE));
  check('error body: top-level STRING `error` + string `code`',
    typeof r.body?.error === 'string' && typeof r.body?.code === 'string', `${r.status} ${JSON.stringify(r.body)}`);
  check('error body: no oRPC internals (defined/status/message)',
    r.body?.defined === undefined && r.body?.status === undefined && r.body?.message === undefined, JSON.stringify(r.body));
}
{
  const r = await read(await post('/rpc/user-keys/store', {}, {}));
  check('gate 403 body has a string `error`', r.status === 403 && typeof r.body?.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
}
{
  const r = await read(await post('/rpc/user-keys/verify-api-key', { api_key: 'nova_sk_short', account_id: 'x.nova-sdk.near' }, GATE));
  check('verify-api-key bad format -> 401 { error:"Invalid format", code:INVALID_API_KEY_FORMAT }',
    r.status === 401 && r.body?.error === 'Invalid format' && r.body?.code === 'INVALID_API_KEY_FORMAT', `${r.status} ${JSON.stringify(r.body)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. agent-identity/* ─────────────────────────────────────────────\n');
// ══════════════════════════════════════════════════════════════════════════════
{
  const r = await read(await post('/rpc/agent-identity/challenge', {}, GATE));
  const m = typeof r.body?.message === 'string' ? JSON.parse(r.body.message) : null;
  check('challenge -> 200 with the 7-field canonical envelope, consistent with its fields',
    r.status === 200 && m && Object.keys(m).length === 7 && m.challenge === r.body.challenge
      && m.audience === r.body.audience && m.expires_at_ms === r.body.expires_at_ms
      && m.expires_at_ms - m.issued_at_ms === 120_000 && !/\s/.test(r.body.message),
    `${r.status} ${JSON.stringify(r.body)}`);
  check('  audience defaults to nova-sdk.near', r.body?.audience === 'nova-sdk.near', String(r.body?.audience));
  const r2 = await read(await post('/rpc/agent-identity/challenge', {}, GATE));
  check('  two calls -> two distinct challenges', r2.body?.challenge && r2.body.challenge !== r.body?.challenge);
}
{
  const r = await read(await post('/rpc/agent-identity/verify', { challenge: 'XYZ', signature: {} }, GATE));
  check('verify malformed -> 400 VALIDATION_FAILED (string error)',
    r.status === 400 && r.body?.code === 'VALIDATION_FAILED' && typeof r.body?.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
}
{
  const wellFormed = (challenge) => ({
    challenge,
    signature: {
      near_account_id: 'alice.near',
      public_key: 'ed25519:11111111111111111111111111111111',
      signature: 'cd'.repeat(64),
      nonce: Buffer.alloc(32).toString('base64'),
      recipient: 'nova-sdk.near',
    },
  });
  const r = await read(await post('/rpc/agent-identity/verify', wellFormed('ab'.repeat(32)), GATE));
  check('verify never-issued challenge -> 401 UNAUTHORIZED_NONCE_REPLAY (before any lookup)',
    r.status === 401 && r.body?.code === 'UNAUTHORIZED_NONCE_REPLAY' && typeof r.body?.error === 'string', `${r.status} ${JSON.stringify(r.body)}`);
  check('  refusal carries no reason/details', r.body?.details === undefined && !/unknown/i.test(r.body?.error ?? ''), JSON.stringify(r.body));

  // Issued challenge + garbage signature: refused at the signature step, still before any lookup.
  const c = await read(await post('/rpc/agent-identity/challenge', {}, GATE));
  const r2 = await read(await post('/rpc/agent-identity/verify', wellFormed(c.body.challenge), GATE));
  check('verify issued challenge + bad signature -> 401 UNAUTHORIZED (generic message)',
    r2.status === 401 && r2.body?.code === 'UNAUTHORIZED' && r2.body?.error === 'Agent identity verification failed', `${r2.status} ${JSON.stringify(r2.body)}`);
  const browserNonce = (await read(await post('/rpc/wallet/nonce', {}, GATE))).body?.nonce;
  const r3 = await read(await post('/rpc/agent-identity/verify', wellFormed(browserNonce), GATE));
  check('verify with a browser wallet nonce as challenge -> 401 UNAUTHORIZED_NONCE_REPLAY (stores disjoint)',
    r3.status === 401 && r3.body?.code === 'UNAUTHORIZED_NONCE_REPLAY', `${r3.status} ${JSON.stringify(r3.body)}`);
}

console.log('\n' + '='.repeat(74));
if (fail === 0) {
  console.log(`ALL ${pass} CHECKS PASSED — gate outermost everywhere, wire format intact, agent-identity wired.`);
  process.exit(0);
} else {
  console.log(`${fail}/${pass + fail} FAILED — DO NOT DEPLOY.`);
  process.exit(1);
}

// shade-agent/test-wallet-apikey-resolve.mjs
//
// Step 2 harness: the wallet-session auth branch in resolveApiKeyTarget
// (user-keys.ts), tested via the exported resolver directly.
//
// WHY DIRECT, NOT via generateApiKey: resolveApiKeyTarget's wallet-session path
// returns the verified-claim account with NO KV call — so calling it directly
// asserts the RESOLVED ACCOUNT with zero KV involvement. (The email path does
// hit KV, but that path is unchanged by step 2 and not under test here.) An
// earlier version tried to intercept kv.js; ESM freezes module namespaces, so
// that reassignment is a TypeError. The exported seam is cleaner and lets us
// assert the exact account string, which the interception approach could not.
//
// §10: every case asserts its EXPECTED OUTCOME explicitly — a resolved account
// is checked for VALUE, a rejection is checked for STATUS. Never conflated.
//
// Run:  npm run build  &&  node test-wallet-apikey-resolve.mjs

import { SignJWT } from 'jose';

const SECRET = 'a'.repeat(64);
const ISSUER = 'https://nova-sdk.com';
const AUDIENCE = 'https://example-8000.dstack-prod5.phala.network';

process.env.SESSION_TOKEN_SECRET = SECRET;
process.env.SESSION_TOKEN_ISSUER = ISSUER;
process.env.SESSION_TOKEN_AUDIENCE = AUDIENCE;

const { resolveApiKeyTarget } = await import('./dist/lib/services/user-keys.js');

const enc = new TextEncoder();
async function mint({
  accountId = 'alice.near',
  subject = `wallet|${accountId}`,
  secret = SECRET, issuer = ISSUER, audience = AUDIENCE,
  type = 'nova_session', expiresAt = null, expiresIn = '24h',
} = {}) {
  return new SignJWT({ account_id: accountId, type })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime(expiresAt ?? expiresIn)
    .sign(enc.encode(secret));
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

// Assert the resolver RETURNS a specific account (auth passed, no KV needed).
async function expectResolves(name, input, wantAccount) {
  try {
    const got = await resolveApiKeyTarget(input);
    ok(`${name} → ${got}`, got === wantAccount);
  } catch (e) {
    fail++;
    const s = e?.statusCode ?? e?.status ?? '?';
    console.log(`  ❌ ${name} — expected '${wantAccount}', REJECTED (${s}: ${e?.code ?? e?.message})`);
  }
}

// Assert the resolver THROWS a specific status (auth rejected).
async function expectRejects(name, input, wantStatus) {
  try {
    const got = await resolveApiKeyTarget(input);
    fail++; console.log(`  ❌ ${name} — expected reject ${wantStatus}, resolved '${got}'`);
  } catch (e) {
    const s = e?.statusCode ?? e?.status;
    ok(`${name} (rejected ${s})`, s === wantStatus);
  }
}

console.log('\n── resolveApiKeyTarget wallet-session harness ──\n');

// 1. HAPPY PATH — valid wallet session resolves to the CLAIM's account.
await expectResolves('valid wallet session',
  { session_token: await mint({ accountId: 'alice.near', subject: 'wallet|alice.near' }) },
  'alice.near');

// 2. SECURITY INVARIANT — bare account_id, no session (Fix E). Still 501.
await expectRejects('bare account_id (Fix E)', { account_id: 'victim.near' }, 501);

// 3. SECURITY INVARIANT — bare wallet_id, no session (Fix E/F). Still 501.
await expectRejects('bare wallet_id (Fix E/F)', { wallet_id: 'victim.near' }, 501);

// 4. FORGED session — wrong secret → 401 (verifyNovaSession).
await expectRejects('forged session (wrong secret)',
  { session_token: await mint({ secret: 'b'.repeat(64) }) }, 401);

// 5. WRONG-SUBJECT — email| session on the wallet path → 403 (wallet|-only gate).
//    Proves the gate does NOT open an Auth0 side-path.
await expectRejects('email| session on wallet path',
  { session_token: await mint({ subject: 'email|a@b.com', accountId: 'a.near' }) }, 403);

// 6. WRONG-SUBJECT — apikey| session → 403.
await expectRejects('apikey| session on wallet path',
  { session_token: await mint({ subject: 'apikey|svc.near', accountId: 'svc.near' }) }, 403);

// 7. EXPIRED wallet session → 401.
await expectRejects('expired wallet session',
  { session_token: await mint({ expiresAt: Math.floor(Date.now() / 1000) - 3600 }) }, 401);

// 8. NO auth at all → 400 MISSING_FIELDS (unchanged).
await expectRejects('empty input', {}, 400);

// 9. THE KEY ANTI-TAKEOVER ASSERTION — a valid wallet session for alice, with a
//    stray body account_id naming someone else. The session's account wins; the
//    body account_id is IGNORED (never trusted). Resolves to ALICE, not attacker.
await expectResolves('valid session + stray body account_id → session wins',
  { session_token: await mint({ accountId: 'alice.near', subject: 'wallet|alice.near' }),
    account_id: 'attacker.near' },
  'alice.near');

console.log(`\n── ${pass} passed, ${fail} failed ──\n`);
process.exit(fail === 0 ? 0 : 1);
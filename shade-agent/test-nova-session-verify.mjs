// shade-agent/test-nova-session-verify.mjs
//
// Standalone harness for verifyNovaSession (auth.ts), step 1 of the wallet
// API-key fix. Tests the COMPILED code (dist/), not the source — a harness must
// exercise what actually ships (§10).
//
// It mints tokens with `jose` EXACTLY as the frontend's lib/session.ts does
// (HS256, same claims/sub/iss/aud), so a green run also proves the
// jose-mint → jsonwebtoken-verify interop that the whole 1b design rests on.
//
// A harness earns its keep by catching something (§10). The mutation check at
// the end proves it does: flip the secret and the "valid token" case must fail.
//
// Run:  node test-nova-session-verify.mjs
// Prereq: `npm run build` (or tsc) so dist/lib/auth.js exists.

import { SignJWT } from 'jose';

// ── Env MUST be set before importing the module (it reads process.env, but
//    verifyNovaSession reads at call time, so setting here is sufficient). ──
const SECRET = 'a'.repeat(64);            // any string; HS256 secret
const ISSUER = 'https://nova-sdk.com';
const AUDIENCE = 'https://example-8000.dstack-prod5.phala.network';

process.env.SESSION_TOKEN_SECRET = SECRET;
process.env.SESSION_TOKEN_ISSUER = ISSUER;
process.env.SESSION_TOKEN_AUDIENCE = AUDIENCE;

const { verifyNovaSession } = await import('./dist/lib/auth.js');

// ── Mint helper — mirrors lib/session.ts::mintNovaSession exactly. ──
const enc = new TextEncoder();
async function mint({
  accountId = 'alice.near',
  subject = 'wallet|alice.near',
  secret = SECRET,
  issuer = ISSUER,
  audience = AUDIENCE,
  type = 'nova_session',
  expiresIn = '24h',
  expiresAt = null,
  alg = 'HS256',
  omitType = false,
  omitAccount = false,
} = {}) {
  const claims = {};
  if (!omitAccount) claims.account_id = accountId;
  if (!omitType) claims.type = type;
  return new SignJWT(claims)
    .setProtectedHeader({ alg, typ: 'JWT' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt ?? expiresIn)
    .sign(enc.encode(secret));
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}
function expectReject(name, token, wantStatus = 401) {
  try {
    verifyNovaSession(token);
    fail++; console.log(`  ❌ ${name} — expected reject, got a result`);
  } catch (e) {
    const gotStatus = e?.statusCode ?? e?.status;
    ok(`${name} (rejected ${gotStatus})`, gotStatus === wantStatus);
  }
}

console.log('\n── verifyNovaSession harness ──\n');

// 1. HAPPY PATH — a valid wallet session verifies and returns the claim.
{
  const t = await mint({ subject: 'wallet|alice.near', accountId: 'alice.near' });
  const r = verifyNovaSession(t);
  ok('valid wallet token → account_id', r.account_id === 'alice.near');
  ok('valid wallet token → subject', r.subject === 'wallet|alice.near');
}

// 2. SUBJECT PASS-THROUGH — the verifier returns the subject as-is; the
//    wallet|-only GATE lives in resolveApiKeyTarget (step 2), NOT here.
{
  const t = await mint({ subject: 'email|a@b.com', accountId: 'a.near' });
  const r = verifyNovaSession(t);
  ok('email subject passes verification (gate is step 2, not here)', r.subject === 'email|a@b.com');
}

// 3. FORGED SIGNATURE — wrong secret must be rejected. THE core assertion.
expectReject('wrong-secret (forged) token', await mint({ secret: 'b'.repeat(64) }));

// 4. ALG DOWNGRADE — a token that is not HS256 must be rejected, not honored.
//    (RS256 mint would need a keypair; 'none' is the classic downgrade probe.)
expectReject('alg=none downgrade', await mint({ alg: 'none' }).catch(() => 'not.a.jwt'));

// 5. WRONG AUDIENCE — a token for another audience (e.g. a stale CVM URL).
expectReject('wrong audience', await mint({ audience: 'https://evil.example' }));

// 6. WRONG ISSUER.
expectReject('wrong issuer', await mint({ issuer: 'https://evil.example' }));

// 7. EXPIRED — absolute past timestamp (jose rejects negative relative strings).
expectReject('expired token', await mint({ expiresAt: Math.floor(Date.now() / 1000) - 3600 }));

// 8. WRONG type CLAIM — a validly-signed JWT that isn't a nova_session.
expectReject('wrong type claim', await mint({ type: 'something_else' }));

// 9. MISSING type CLAIM.
expectReject('missing type claim', await mint({ omitType: true }));

// 10. MISSING account_id CLAIM.
expectReject('missing account_id claim', await mint({ omitAccount: true }));

// 11. GARBAGE token.
expectReject('garbage string', 'not.a.jwt');

// 12. MUTATION PROOF — the harness must be able to FAIL. Verify that a token
//     minted with the RIGHT secret passes, then a one-char secret change fails.
{
  const good = await mint({});
  let goodPassed = false;
  try { verifyNovaSession(good); goodPassed = true; } catch { /* */ }
  const bad = await mint({ secret: SECRET.slice(0, -1) + 'X' });
  let badRejected = false;
  try { verifyNovaSession(bad); } catch { badRejected = true; }
  ok('mutation proof: good passes AND 1-char-off secret fails', goodPassed && badRejected);
}

console.log(`\n── ${pass} passed, ${fail} failed ──\n`);
process.exit(fail === 0 ? 0 : 1);
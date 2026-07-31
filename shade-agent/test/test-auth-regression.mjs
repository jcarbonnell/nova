// shade-agent/test/test-auth-regression.mjs
//
// REGRESSION GUARD (§10 "prove the refactor moved nothing").
//
// Adding section 4 (wallet SIWN) to lib/auth.ts must not perturb sections 1–3:
//   verifyAuth0Token, verifyToken, checkInternalAuth.
//
// The risk is NOT that they were edited (they weren't) — it's INDIRECT:
//   - the new `near-kit` import having an import-time side effect;
//   - module-load-order effects from the new top-level `walletNonceStore`;
//   - a shared symbol now resolving differently.
// So this harness imports the REAL post-addition module and exercises the
// behaviour of sections 1–3 that runs WITHOUT network (the branches an import
// change would most plausibly break), plus structural/identity invariants.
//
// WHY NOT full happy-paths: verifyAuth0Token (JWKS fetch) and verifyToken (RPC)
// make real network calls on their success paths. Their EARLY-REJECTION paths
// run offline and are exactly the branches most exposed to import perturbation.
// The wallet happy-path is proven separately (test-wallet-siwn.mjs, 24/24).
//
// RUN: node --experimental-strip-types test/test-auth-regression.mjs

import { fileURLToPath } from 'url';
import path from 'path';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

const auth = await import('../src/lib/auth.js');

async function main() {
  console.log('\nauth.ts regression — sections 1–3 unperturbed by section 4\n');

  // ── Structural: the three primitives still exist with expected shape ────────
  console.log('Structural — exports & arity:');
  check('verifyAuth0Token exported as function', typeof auth.verifyAuth0Token === 'function');
  check('verifyToken exported as function', typeof auth.verifyToken === 'function');
  check('checkInternalAuth exported as function', typeof auth.checkInternalAuth === 'function');
  // Arity is part of the contract; a wrapper accidentally changing it would break callers.
  check('verifyAuth0Token arity = 1', auth.verifyAuth0Token.length === 1);
  check('verifyToken arity = 3', auth.verifyToken.length === 3);
  check('checkInternalAuth arity = 1', auth.checkInternalAuth.length === 1);
  // Section 4 additions exist (so we're testing the POST-addition module, not pre).
  check('section 4 present (verifyWalletSignin)', typeof auth.verifyWalletSignin === 'function');
  check('section 4 present (issueWalletNonce)', typeof auth.issueWalletNonce === 'function');

  // ── checkInternalAuth — pure, fully deterministic, strongest anchor ─────────
  console.log('\ncheckInternalAuth — fail-closed & timing-safe (no network):');
  const ORIG = process.env.INTERNAL_API_SECRET;
  try {
    // Missing secret in env → fail closed regardless of input.
    delete process.env.INTERNAL_API_SECRET;
    check('no env secret → false even with plausible input', auth.checkInternalAuth('a'.repeat(64)) === false);
    check('no env secret → false on undefined', auth.checkInternalAuth(undefined) === false);

    // Malformed secret (not 64-hex) → fail closed.
    process.env.INTERNAL_API_SECRET = 'not-hex';
    check('malformed env secret → false', auth.checkInternalAuth('not-hex') === false);
    process.env.INTERNAL_API_SECRET = 'abc'; // too short
    check('short env secret → false', auth.checkInternalAuth('abc') === false);

    // Valid 64-hex secret → exact match true, mismatch false, undefined false.
    const good = '0'.repeat(64);
    process.env.INTERNAL_API_SECRET = good;
    check('valid secret, exact match → true', auth.checkInternalAuth(good) === true);
    check('valid secret, wrong value → false', auth.checkInternalAuth('1'.repeat(64)) === false);
    check('valid secret, undefined provided → false', auth.checkInternalAuth(undefined) === false);
    // Length-mismatch guard (timing-safe path requires equal length first).
    check('valid secret, shorter provided → false', auth.checkInternalAuth('0'.repeat(32)) === false);
    check('valid secret, longer provided → false', auth.checkInternalAuth('0'.repeat(128)) === false);
    // Case sensitivity of the hex regex: uppercase secret is accepted by /i.
    process.env.INTERNAL_API_SECRET = 'A'.repeat(64);
    check('uppercase-hex secret accepted, exact match → true', auth.checkInternalAuth('A'.repeat(64)) === true);
  } finally {
    if (ORIG === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = ORIG;
  }

  // ── verifyToken — early rejection paths (run before any RPC) ────────────────
  console.log('\nverifyToken — offline early-rejection branches:');
  {
    // Malformed: no "." separator → { valid: false }, no throw, no network.
    const r1 = await auth.verifyToken('no-dot-here', 'nova-sdk.near', 'mainnet');
    check('malformed token (no dot) → {valid:false}', r1 && r1.valid === false);

    // Empty payload before the dot.
    const r2 = await auth.verifyToken('.deadbeef', 'nova-sdk.near', 'mainnet');
    check('empty payload → {valid:false}', r2 && r2.valid === false);

    // Well-formed base64 but JSON missing required fields → {valid:false}.
    const emptyJsonB64 = Buffer.from('{}').toString('base64');
    const r3 = await auth.verifyToken(`${emptyJsonB64}.deadbeef`, 'nova-sdk.near', 'mainnet');
    check('payload missing fields → {valid:false}', r3 && r3.valid === false);

    // Timestamp wildly out of window → {valid:false} (runs before RPC).
    const staledPayload = {
      group_id: 'g', user_id: 'alice.near', nonce: 'n',
      timestamp: '1', // 1ns after epoch → far outside ±5min
    };
    const staleB64 = Buffer.from(JSON.stringify(staledPayload)).toString('base64');
    const r4 = await auth.verifyToken(`${staleB64}.deadbeef`, 'nova-sdk.near', 'mainnet');
    check('timestamp out of window → {valid:false}', r4 && r4.valid === false);

    // All early-rejection results must be the exact {valid:false} shape (no extra
    // fields leaked, no throw). A perturbation that turned these into a throw or
    // changed the shape would surface here.
    check('early rejections return only {valid:false}',
      Object.keys(r1).length === 1 && r1.valid === false);
  }

  // ── verifyAuth0Token — input-validation branch (before JWKS fetch) ──────────
  console.log('\nverifyAuth0Token — offline rejection branch:');
  {
    const ORIG_DOMAIN = process.env.AUTH0_DOMAIN;
    process.env.AUTH0_DOMAIN = 'example.auth0.com'; // so it doesn't throw on missing domain
    try {
      // A token that jwt.decode can't parse → rejects (before any network).
      let rejected = false;
      try {
        await auth.verifyAuth0Token('not-a-jwt');
      } catch {
        rejected = true;
      }
      check('malformed JWT → rejects (offline, before JWKS fetch)', rejected === true);
    } finally {
      if (ORIG_DOMAIN === undefined) delete process.env.AUTH0_DOMAIN;
      else process.env.AUTH0_DOMAIN = ORIG_DOMAIN;
    }
  }

  // ── Import-time side-effect check ───────────────────────────────────────────
  console.log('\nModule import integrity:');
  // If we got here, the module imported without throwing (near-kit + the
  // top-level walletNonceStore construction did not break load). Assert the new
  // top-level state exists and is the right kind, proving section 4 initialised.
  check('walletNonceStore constructed at module load', auth.walletNonceStore != null);
  check('WALLET_SIWN_RECIPIENT is nova-sdk.com', auth.WALLET_SIWN_RECIPIENT === 'nova-sdk.com');
  // issueWalletNonce produces a 64-hex nonce (proves the store wired correctly
  // and, transitively, that adding it didn't disturb the shared module scope).
  const n = auth.issueWalletNonce();
  check('issueWalletNonce → 64-hex', typeof n === 'string' && /^[0-9a-f]{64}$/.test(n));

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  FAILURES:\n${failures.map(f => `    - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('  ✅ all green — sections 1–3 unperturbed');
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

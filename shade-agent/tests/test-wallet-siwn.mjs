// shade-agent/test/test-wallet-siwn.mjs
//
// HARNESS-FIRST (§10): proves NOVA's wallet SIWN logic against the REAL
// near-kit 0.19.0 verifier and the REAL WalletNonceStore, fully offline.
//
// WHAT THIS PROVES (our responsibilities):
//   - recipient binding, the Shade-owned nonce lifecycle (issue/replay/expiry),
//     check-first/consume-last ordering, the two-layer verify with the right
//     error codes, and that near-kit's options are wired correctly
//     (nonceValidation:"none" + {near} so full-access-key enforcement is live).
//
// WHAT THIS DOES NOT RE-PROVE (near-kit's responsibilities):
//   - the borsh+tag+sha256 construction and the point key-lookup mechanics.
//     Those are near-kit's tested code. We sign with near-kit's OWN signMessage
//     and verify with its OWN verifyNep413Signature, so both sides of the wire
//     are the real library — more honest than hand-serialising the bytes.
//
// THE MOCK SEAM (the one thing that makes this offline):
//   near-kit's verifier does exactly:
//       const ak = await near.getAccessKey(msg.accountId, msg.publicKey);
//       if (!ak || ak.permission !== "FullAccess") return false;
//   So we override ONE method — getAccessKey — on a real Near instance.
//   Everything cryptographic runs for real; only the "is this key on-chain and
//   full-access?" answer is stubbed. Layer 0 guards against an inert mock.
//
// RUN: node test/test-wallet-siwn.mjs   (near-kit@0.19.0 installed)

import { Near, InMemoryKeyStore, generateKey, verifyNep413Signature } from 'near-kit';
import { hex } from '@scure/base';
import { WalletNonceStore } from '../src/lib/wallet-nonce.ts';

// ────────────────────────────────────────────────────────────────────────────
// Test harness scaffolding
// ────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

const RECIPIENT = 'nova-sdk.com'; // NOVA's NEP-413 recipient (locked decision)

// ────────────────────────────────────────────────────────────────────────────
// Offline signing: a real Near instance backed by an in-memory key, used ONLY
// to produce genuine SignedMessage objects — exactly what a wallet returns.
// ────────────────────────────────────────────────────────────────────────────

/** Make a signer for accountId with a fresh full-access-style keypair.
 *  Returns { near, accountId, publicKey, sign(params) }. */
function makeSigner(accountId, network = 'mainnet') {
  const kp = generateKey(); // { publicKey: PublicKey obj, secretKey: "ed25519:..", privateKey: Uint8Array }
  const keyStore = new InMemoryKeyStore({ [accountId]: kp.secretKey });
  const near = new Near({ network, keyStore, defaultSignerId: accountId });
  return {
    near,
    accountId,
    publicKey: kp.publicKey.toString(), // string form, matches SignedMessage.publicKey
    secretKey: kp.secretKey,
    async sign({ message, recipient, nonceBytes }) {
      return near.signMessage(
        { message, recipient, nonce: nonceBytes },
        { signerId: accountId },
      );
    },
  };
}

/**
 * A verifier Near whose getAccessKey is mocked from a registry of
 * (accountId, publicKey) -> permission. Absent pairs return null (i.e. "not an
 * on-chain key for this account"), which is how the attacker/unknown cases fail.
 */
function makeVerifierNear(registry) {
  const near = new Near({ network: 'mainnet' });
  near.getAccessKey = async (accountId, publicKey) => {
    const permission = registry.get(`${accountId}|${publicKey}`);
    if (!permission) return null;
    return { permission, nonce: 0, block_height: 1, block_hash: 'x' };
  };
  return near;
}

function reg(pairs) {
  const m = new Map();
  for (const [accountId, publicKey, permission] of pairs) {
    m.set(`${accountId}|${publicKey}`, permission);
  }
  return m;
}

// ────────────────────────────────────────────────────────────────────────────
// The route logic under test, in miniature.
//
// This mirrors EXACTLY what the Shade /rpc/wallet/verify route will do, so the
// harness tests the real ordering. When the route is written, it calls the same
// three steps in the same order. Error codes match Elliot's plugin
// (UNAUTHORIZED_NONCE_REPLAY vs UNAUTHORIZED) for §5.11-B wire-alignment.
//
//   1. checkNonce (non-mutating)          -> UNAUTHORIZED_NONCE_REPLAY on fail
//   2. verifyNep413Signature (boolean)    -> UNAUTHORIZED on fail
//      (covers signature + recipient + on-chain full-access key, all at once)
//   3. consumeNonce (only on full success)-> UNAUTHORIZED_NONCE_REPLAY if lost
//
// check-first / consume-LAST: a bad signature must NOT burn a victim's nonce.
// ────────────────────────────────────────────────────────────────────────────

async function verifyWalletSignin({ store, verifierNear, signedMessage, message, nonceHex }) {
  // Layer 1: nonce validity (Shade-owned; near-kit does none of this under "none")
  const nonceCheck = store.checkNonce(nonceHex);
  if (!nonceCheck.ok) {
    return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: nonceCheck.reason };
  }

  // Layer 2: cryptographic + recipient + on-chain full-access-key (near-kit)
  const params = {
    message,
    recipient: RECIPIENT,
    nonce: hex.decode(nonceHex),
  };
  const sigValid = await verifyNep413Signature(signedMessage, params, {
    near: verifierNear,
    nonceValidation: 'none', // Shade owns nonce/replay; treat bytes as opaque
  });
  if (!sigValid) {
    // Nonce intentionally NOT consumed here — bad sig must not burn it.
    return { ok: false, code: 'UNAUTHORIZED' };
  }

  // Layer 3: consume only after full success
  const consumed = store.consumeNonce(nonceHex);
  if (!consumed) {
    return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: 'consume_failed' };
  }

  return { ok: true, accountId: signedMessage.accountId };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nWallet SIWN harness — near-kit@0.19.0, offline, mocked lookup\n');

  // ── Layer 0: mock sanity (guards the offline approach itself) ──────────────
  console.log('Layer 0 — mock sanity:');
  {
    const alice = makeSigner('alice.near');
    const store = new WalletNonceStore();
    const nonceHex = store.issueNonce();

    // Good key registered as FullAccess.
    const goodNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FullAccess']]));
    const sm = await alice.sign({ message: 'Login', recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
    const okValid = await verifyNep413Signature(
      sm, { message: 'Login', recipient: RECIPIENT, nonce: hex.decode(nonceHex) },
      { near: goodNear, nonceValidation: 'none' },
    );
    check('0.1 full-access key for claimed account → near-kit returns true (mock feeds real verify)', okValid === true);

    // Same signature, but the SAME account's on-chain key set does NOT include
    // this pubkey → must fail THROUGH the same mock (mock is not inert).
    const badNear = makeVerifierNear(reg([[alice.accountId, 'ed25519:11111111111111111111111111111111', 'FullAccess']]));
    const okInert = await verifyNep413Signature(
      sm, { message: 'Login', recipient: RECIPIENT, nonce: hex.decode(nonceHex) },
      { near: badNear, nonceValidation: 'none' },
    );
    check('0.2 wrong key for same account (same mock) → near-kit returns false (mock not inert)', okInert === false);
  }

  // ── Layer 1: happy path (assert-valid-FIRST, §10) ──────────────────────────
  console.log('\nLayer 1 — happy path:');
  {
    const alice = makeSigner('alice.near');
    const store = new WalletNonceStore();
    const verifierNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FullAccess']]));
    const nonceHex = store.issueNonce();
    const message = 'Login to NOVA';
    const sm = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });

    const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
    check('1.1 issued nonce + correct recipient + full-access sig → SUCCESS', res.ok === true);
    check('1.2 success returns the signer accountId', res.accountId === 'alice.near');
    check('1.3 nonce is consumed after success', store.checkNonce(nonceHex).ok === false);
    check('1.4 consumed reason is "consumed" (not "unknown"/"expired")', store.checkNonce(nonceHex).reason === 'consumed');
  }

  // ── Layer 2: recipient binding (phishing guard) ────────────────────────────
  console.log('\nLayer 2 — recipient binding:');
  {
    const alice = makeSigner('alice.near');
    const store = new WalletNonceStore();
    const verifierNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FullAccess']]));
    const nonceHex = store.issueNonce();
    const message = 'Login to NOVA';
    // Signed for a DIFFERENT recipient — a signature captured by otherapp.com.
    const sm = await alice.sign({ message, recipient: 'otherapp.com', nonceBytes: hex.decode(nonceHex) });

    const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
    check('2.1 signature for a different recipient → UNAUTHORIZED', res.ok === false && res.code === 'UNAUTHORIZED');
    check('2.2 rejected wrong-recipient nonce remains usable (not burned)', store.checkNonce(nonceHex).ok === true);
  }

  // ── Layer 3: nonce lifecycle (the part near-kit delegates to us) ────────────
  console.log('\nLayer 3 — nonce lifecycle:');
  {
    const alice = makeSigner('alice.near');
    const verifierNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FullAccess']]));
    const message = 'Login to NOVA';

    // 3.1 client-invented nonce Shade never issued.
    {
      const store = new WalletNonceStore();
      const foreignNonce = 'ab'.repeat(32); // 32 bytes hex, never issued
      const sm = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(foreignNonce) });
      const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex: foreignNonce });
      check('3.1 nonce never issued by Shade → UNAUTHORIZED_NONCE_REPLAY (server-issued invariant)',
        res.ok === false && res.code === 'UNAUTHORIZED_NONCE_REPLAY' && res.reason === 'unknown');
    }

    // 3.2 replay: consume a valid nonce, then reuse it.
    {
      const store = new WalletNonceStore();
      const nonceHex = store.issueNonce();
      const sm = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
      const first = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
      const second = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
      check('3.2a first use of nonce → success', first.ok === true);
      check('3.2b replay of consumed nonce → UNAUTHORIZED_NONCE_REPLAY',
        second.ok === false && second.code === 'UNAUTHORIZED_NONCE_REPLAY' && second.reason === 'consumed');
    }

    // 3.3 expiry via injected clock (no sleep).
    {
      let t = 1_000_000;
      const store = new WalletNonceStore({ ttlMs: 15 * 60 * 1000, now: () => t });
      const nonceHex = store.issueNonce();
      const sm = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
      t += 15 * 60 * 1000 + 1; // advance just past the TTL
      const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
      check('3.3 expired nonce (>15min, injected clock) → UNAUTHORIZED_NONCE_REPLAY',
        res.ok === false && res.code === 'UNAUTHORIZED_NONCE_REPLAY' && res.reason === 'expired');
    }
  }

  // ── Layer 3b: check-first / consume-LAST (the subtle griefing guard) ────────
  console.log('\nLayer 3b — check-first / consume-last ordering:');
  {
    const alice = makeSigner('alice.near');
    const store = new WalletNonceStore();
    const verifierNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FullAccess']]));
    const nonceHex = store.issueNonce();
    const message = 'Login to NOVA';

    // A valid nonce, but a BAD signature (signed over a different message than
    // the one presented to verify). near-kit returns false; the nonce must NOT
    // be consumed, so the legitimate user can still use it.
    const smBad = await alice.sign({ message: 'a different message', recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
    const res = await verifyWalletSignin({ store, verifierNear, signedMessage: smBad, message, nonceHex });
    check('3b.1 valid nonce + bad signature → UNAUTHORIZED', res.ok === false && res.code === 'UNAUTHORIZED');
    check('3b.2 nonce still usable after bad-signature attempt (not burned)', store.checkNonce(nonceHex).ok === true);

    // And to prove it is genuinely still usable: a correct signature now succeeds.
    const smGood = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
    const res2 = await verifyWalletSignin({ store, verifierNear, signedMessage: smGood, message, nonceHex });
    check('3b.3 same nonce then accepts a correct signature → success', res2.ok === true);
  }

  // ── Layer 4: key-permission (near-kit enforces; we assert the wiring) ───────
  console.log('\nLayer 4 — key permission (full-access enforcement):');
  {
    const message = 'Login to NOVA';

    // 4.1 function-call key → rejected. Registry marks the signing key FunctionCall.
    {
      const alice = makeSigner('alice.near');
      const store = new WalletNonceStore();
      const verifierNear = makeVerifierNear(reg([[alice.accountId, alice.publicKey, 'FunctionCall']]));
      const nonceHex = store.issueNonce();
      const sm = await alice.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
      const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
      check('4.1 function-call key (not full-access) → UNAUTHORIZED (confirms {near} is passed)',
        res.ok === false && res.code === 'UNAUTHORIZED');
    }

    // 4.2 attacker signs, claims victim's account. Victim's on-chain set does
    //     not contain the attacker's key → getAccessKey(victim, attacker_pk)=null.
    {
      const attacker = makeSigner('attacker.near');
      const store = new WalletNonceStore();
      // Registry knows only the victim's REAL (different) key as full-access.
      const verifierNear = makeVerifierNear(reg([['victim.near', 'ed25519:22222222222222222222222222222222', 'FullAccess']]));
      const nonceHex = store.issueNonce();
      // Attacker produces a real signature but the SignedMessage claims victim.near.
      const smAttacker = await attacker.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
      const forged = { ...smAttacker, accountId: 'victim.near' }; // claim victim
      const res = await verifyWalletSignin({ store, verifierNear, signedMessage: forged, message, nonceHex });
      check('4.2 attacker key signing for victim account → UNAUTHORIZED (Fix 6 invariant)',
        res.ok === false && res.code === 'UNAUTHORIZED');
    }
  }

  // ── Layer 5: multi-key account (carried from verifyToken behaviour) ─────────
  console.log('\nLayer 5 — multi-key account:');
  {
    // Account with TWO full-access keys; sign with the second. near-kit does a
    // POINT lookup by the exact signing pubkey, so as long as that pubkey is
    // registered full-access, it passes regardless of how many others exist.
    const message = 'Login to NOVA';
    const second = makeSigner('multi.near');
    const firstKp = generateKey(); // a second distinct full-access key on the same account
    const store = new WalletNonceStore();
    const verifierNear = makeVerifierNear(reg([
      ['multi.near', firstKp.publicKey.toString(), 'FullAccess'],
      ['multi.near', second.publicKey, 'FullAccess'],
    ]));
    const nonceHex = store.issueNonce();
    const sm = await second.sign({ message, recipient: RECIPIENT, nonceBytes: hex.decode(nonceHex) });
    const res = await verifyWalletSignin({ store, verifierNear, signedMessage: sm, message, nonceHex });
    check('5.1 multi-key account, signature from 2nd full-access key → success', res.ok === true);
  }

  // ── Layer 6: regression guard on the nonce store's own invariants ──────────
  // (The lib/auth.ts primitives verifyToken/verifyAuth0Token/checkInternalAuth
  //  are guarded in a separate harness that imports the real compiled lib; here
  //  we lock the store's own edge invariants that the route depends on.)
  console.log('\nLayer 6 — nonce store invariants:');
  {
    const store = new WalletNonceStore({ now: (() => { let t = 0; return () => t; })() });
    const n = store.issueNonce();
    check('6.1 issued nonce is 64 hex chars (32 bytes)', /^[0-9a-f]{64}$/.test(n));
    check('6.2 fresh issued nonce checks ok', store.checkNonce(n).ok === true);
    check('6.3 consume returns true once', store.consumeNonce(n) === true);
    check('6.4 consume returns false the second time (no double-spend)', store.consumeNonce(n) === false);
    check('6.5 unknown nonce consume returns false', store.consumeNonce('cd'.repeat(32)) === false);
    const s2 = new WalletNonceStore();
    const a = s2.issueNonce();
    const b = s2.issueNonce();
    check('6.6 two issued nonces are distinct', a !== b);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  FAILURES:\n${failures.map(f => `    - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('  ✅ all green');
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

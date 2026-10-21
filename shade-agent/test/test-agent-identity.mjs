// shade-agent/test/test-agent-identity.mjs
//
// HARNESS-FIRST (§10): proves src/lib/agent-identity.ts — the Agent Connect
// identity verifier — fully offline, BEFORE any route or image exists.
//
// v2 (2026-10-21): native accounts. The API's `native/near/sign-message` signs
// NOVA's message with NOVA's nonce and returns a base64 signature; the retired
// `api.sign` (API-chosen nonce, hex signature) is refused. Layer 9 replays a REAL
// signature captured from api.demo.agentsonintents.com (2026-10-21).
//
// Unlike test-wallet-siwn.mjs (which tests a miniature mirror of the route),
// this imports the REAL module: verifyAgentIdentity has injected deps (clock,
// typed key lookup), so the production function itself runs here.
//
// SIGNING SIDE = a simulated Agent API native/near/sign-message: near-kit's own
// signMessage over the stored canonical envelope with the caller's (NOVA's)
// NEP-413 nonce, in the API's wire shape (signature base64, nonce base64).
// ORACLE = the API's reference (examples repo support/identity.ts): its pure
// nep413Digest is pasted VERBATIM below (layer 8); signatures
// made by an independent signer (node:crypto ed25519) over the REFERENCE digest
// must verify through near-kit and through the real module.
//
// MOCK SEAM: the typed KeyLookup only. Layer 0 guards against an inert mock.
//
// RUN (from shade-agent/):
//   node --experimental-strip-types test/test-agent-identity.mjs
//   (optional: pass a module path as argv[2] — used by the mutation checks)

import path from 'node:path';
import { createHash, randomBytes, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Near, InMemoryKeyStore, generateKey, verifyNep413Signature } from 'near-kit';
import { base58 } from '@scure/base';
import { WalletNonceStore } from '../src/lib/wallet-nonce.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modPath = process.argv[2] || path.join(__dirname, '../src/lib/agent-identity.ts');
const M = await import(pathToFileURL(path.resolve(modPath)).href);
const { AgentChallengeStore, verifyAgentIdentity, canonicalJson, IDENTITY_DOMAIN } = M;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}

const AUD = 'nova-sdk.near';

// ── signers ─────────────────────────────────────────────────────────────────
// accountId omitted → implicit account derived from the key (hex of pubkey).
function makeAgent(accountId) {
  const kp = generateKey();
  const pubBytes = kp.publicKey.data;
  const id = accountId ?? Buffer.from(pubBytes).toString('hex');
  const near = new Near({ network: 'mainnet', keyStore: new InMemoryKeyStore({ [id]: kp.secretKey }), defaultSignerId: id });
  return {
    accountId: id,
    publicKey: kp.publicKey.toString(),
    pubBytes,
    seed: kp.privateKey ? kp.privateKey.slice(0, 32) : undefined,
    /** Simulates native/near/sign-message: caller's nonce (base64 or bytes), API wire shape. */
    async sign(message, recipient = AUD, nonce = randomBytes(32)) {
      const n = typeof nonce === 'string' ? Buffer.from(nonce, 'base64') : Buffer.from(nonce);
      const sm = await near.signMessage({ message, recipient, nonce: n }, { signerId: id });
      return {
        near_account_id: id,
        public_key: sm.publicKey,
        signature: sm.signature, // base64
        nonce: n.toString('base64'),
        recipient,
      };
    },
  };
}

// ── typed lookup mock: Map "account|pk" → result; accounts set = existing accounts ──
function makeLookup({ keys = [], accounts = [], throws = false } = {}) {
  const km = new Map(keys.map(([a, pk, perm]) => [`${a}|${pk}`, perm]));
  const am = new Set([...accounts, ...keys.map(([a]) => a)]);
  const calls = [];
  const fn = async (a, pk) => {
    calls.push([a, pk]);
    if (throws) throw new Error('rpc down');
    if (!am.has(a)) return { kind: 'no_account' };
    const perm = km.get(`${a}|${pk}`);
    return perm ? { kind: 'access_key', permission: perm } : { kind: 'no_access_key' };
  };
  fn.calls = calls;
  return fn;
}

const store = (o = {}) => new AgentChallengeStore({ audience: AUD, ...o });
const verify = (s, lookup, challenge, signature) => verifyAgentIdentity({ store: s, lookup }, { challenge, signature });

async function main() {
  console.log('\nAgent identity harness — real module, near-kit@0.19.0, offline\n');

  // ── 0. mock sanity ──────────────────────────────────────────────────────────
  console.log('Layer 0 — mock sanity:');
  {
    const alice = makeAgent('alice.near');
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const sig = await alice.sign(message, AUD, nonce);
    const bad = await verify(s, makeLookup({ accounts: ['alice.near'] }), challenge.challenge, sig);
    check('0.1 same signature, key NOT on account (same mock) → refused (mock not inert)', bad.ok === false && bad.reason === 'key_not_on_account');
    const good = await verify(s, makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] }), challenge.challenge, sig);
    check('0.2 key registered FullAccess → accepted (mock feeds the real path)', good.ok === true);
  }

  // ── 1. happy path ───────────────────────────────────────────────────────────
  console.log('\nLayer 1 — happy path (named account):');
  {
    const alice = makeAgent('alice.near');
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const r = await verify(s, lookup, challenge.challenge, await alice.sign(message, AUD, nonce));
    check('1.1 issued challenge + full-access key → ok', r.ok === true);
    check('1.2 returns the account and key', r.account_id === 'alice.near' && r.public_key === alice.publicKey);
    check('1.3 challenge consumed after success', s.check(challenge.challenge).ok === false);
    check('1.4 reason is "consumed"', s.check(challenge.challenge).reason === 'consumed');
  }

  // ── 2. recipient binding ────────────────────────────────────────────────────
  console.log('\nLayer 2 — recipient binding:');
  {
    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const other = await alice.sign(message, 'other.near', nonce);
    const r1 = await verify(s, lookup, challenge.challenge, other);
    check('2.1 signature for another recipient → UNAUTHORIZED/recipient', r1.ok === false && r1.code === 'UNAUTHORIZED' && r1.reason === 'recipient');
    // Relabel: recipient field claims ours, bytes were signed for other.near.
    const r2 = await verify(s, lookup, challenge.challenge, { ...other, recipient: AUD });
    check('2.2 recipient relabelled to ours, signed for another → UNAUTHORIZED/signature', r2.ok === false && r2.reason === 'signature');
    check('2.3 challenge still usable after both', s.check(challenge.challenge).ok === true);
    check('2.4 no key lookup was made for a bad signature (no RPC amplification)', lookup.calls.length === 0);
  }

  // ── 3. challenge lifecycle ──────────────────────────────────────────────────
  console.log('\nLayer 3 — challenge lifecycle:');
  {
    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    {
      const s = store();
      const forged = 'ab'.repeat(32);
      const msg = canonicalJson({ domain: IDENTITY_DOMAIN, purpose: 'identity', chain: 'near', audience: AUD, challenge: forged, issued_at_ms: Date.now(), expires_at_ms: Date.now() + 60000 });
      const r = await verify(s, lookup, forged, await alice.sign(msg));
      check('3.1 client-invented challenge → UNAUTHORIZED_NONCE_REPLAY/unknown', r.ok === false && r.code === 'UNAUTHORIZED_NONCE_REPLAY' && r.reason === 'unknown');
    }
    {
      const s = store();
      const { challenge, message, nonce } = s.issue();
      const sig = await alice.sign(message, AUD, nonce);
      const a = await verify(s, lookup, challenge.challenge, sig);
      const b = await verify(s, lookup, challenge.challenge, sig);
      check('3.2a first use → ok', a.ok === true);
      check('3.2b replay → UNAUTHORIZED_NONCE_REPLAY/consumed', b.ok === false && b.code === 'UNAUTHORIZED_NONCE_REPLAY' && b.reason === 'consumed');
      const c2 = await verify(s, lookup, challenge.challenge, await alice.sign(message));
      check('3.2c replay with a fresh nonce → still refused (consumed is checked first)', c2.ok === false && c2.reason === 'consumed');
    }
    {
      let t = 1_000_000;
      const s = store({ now: () => t });
      const { challenge, message, nonce } = s.issue();
      const sig = await alice.sign(message, AUD, nonce);
      t = challenge.expires_at_ms - 1;
      check('3.3a 1 ms before expiry → challenge checks ok', s.check(challenge.challenge).ok === true);
      t = challenge.expires_at_ms;
      const r = await verify(s, lookup, challenge.challenge, sig);
      check('3.3b at expires_at_ms → UNAUTHORIZED_NONCE_REPLAY/expired (same >= rule as the API)', r.ok === false && r.reason === 'expired');
    }
    {
      const s = store();
      const ws = new WalletNonceStore();
      const browserNonce = ws.issueNonce();
      const r = await verify(s, lookup, browserNonce, await alice.sign('x'));
      check('3.4 a browser-SIWN nonce presented as a challenge → unknown (stores are disjoint)', r.ok === false && r.reason === 'unknown');
    }
  }

  // ── 3b. check-first / consume-last ──────────────────────────────────────────
  console.log('\nLayer 3b — ordering (nothing burns an issued challenge):');
  {
    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const r1 = await verify(s, lookup, challenge.challenge, await alice.sign(message + ' ', AUD, nonce));
    check('3b.1 signature over a different message → UNAUTHORIZED/signature', r1.ok === false && r1.reason === 'signature');
    check('3b.2 challenge not burned', s.check(challenge.challenge).ok === true);
    const r2 = await verify(s, makeLookup({ throws: true }), challenge.challenge, await alice.sign(message, AUD, nonce));
    check('3b.3 key lookup outage → KEY_LOOKUP_UNAVAILABLE (fail closed)', r2.ok === false && r2.code === 'KEY_LOOKUP_UNAVAILABLE');
    check('3b.4 challenge not burned by the outage', s.check(challenge.challenge).ok === true);
    const r3 = await verify(s, lookup, challenge.challenge, await alice.sign(message, AUD, nonce));
    check('3b.5 same challenge then accepts a correct signature', r3.ok === true);
  }

  // ── 4. key control ──────────────────────────────────────────────────────────
  console.log('\nLayer 4 — key control:');
  {
    const run = async (agent, lookup, override = {}) => {
      const s = store();
      const { challenge, message, nonce } = s.issue();
      const sig = { ...(await agent.sign(message, AUD, nonce)), ...override };
      return verify(s, lookup, challenge.challenge, sig);
    };
    const alice = makeAgent('alice.near');
    const r1 = await run(alice, makeLookup({ keys: [['alice.near', alice.publicKey, 'FunctionCall']] }));
    check('4.1 function-call key → UNAUTHORIZED/function_call_key', r1.ok === false && r1.reason === 'function_call_key');

    const attacker = makeAgent('attacker.near');
    const victimKey = generateKey().publicKey.toString();
    // Attacker's real signature, but claims victim.near. account_id is outside the
    // NEP-413 digest, so the signature still verifies — key control must catch it.
    const r2 = await run(attacker, makeLookup({ keys: [['victim.near', victimKey, 'FullAccess']] }), { near_account_id: 'victim.near' });
    check('4.2 attacker key claiming victim.near → UNAUTHORIZED/key_not_on_account', r2.ok === false && r2.reason === 'key_not_on_account');

    const imp = makeAgent(); // implicit, not on chain
    const r3 = await run(imp, makeLookup({}));
    check('4.3 implicit account not on chain, id == key → ok', r3.ok === true && r3.account_id === imp.accountId);

    const imp2 = makeAgent();
    const r4 = await run(attacker, makeLookup({}), { near_account_id: imp2.accountId });
    check('4.4 claiming someone else\'s implicit id (key mismatch) → UNAUTHORIZED/account_not_found', r4.ok === false && r4.reason === 'account_not_found');

    const r5 = await run(makeAgent('ghost.near'), makeLookup({}));
    check('4.5 named account that does not exist → UNAUTHORIZED/account_not_found', r5.ok === false && r5.reason === 'account_not_found');

    // Implicit account that EXISTS on chain and whose original key was rotated out.
    const imp3 = makeAgent();
    const r6 = await run(imp3, makeLookup({ accounts: [imp3.accountId] }));
    check('4.6 existing implicit account, original key rotated out → UNAUTHORIZED/key_not_on_account', r6.ok === false && r6.reason === 'key_not_on_account');

    const r7 = await run(imp3, makeLookup({ throws: true }));
    check('4.7 same, during an RPC outage → KEY_LOOKUP_UNAVAILABLE (NOT the implicit branch)', r7.ok === false && r7.code === 'KEY_LOOKUP_UNAVAILABLE');

    const bob = makeAgent('bob.near');
    const r8 = await run(bob, makeLookup({ keys: [['bob.near', generateKey().publicKey.toString(), 'FullAccess'], ['bob.near', bob.publicKey, 'FullAccess']] }));
    check('4.8 multi-key account, signed with the 2nd full-access key → ok', r8.ok === true);

    const r9 = await run(alice, async () => ({ kind: 'surprise' }));
    check('4.9 lookup returns an unknown shape → KEY_LOOKUP_UNAVAILABLE', r9.ok === false && r9.code === 'KEY_LOOKUP_UNAVAILABLE');
  }

  // ── 5. the envelope ─────────────────────────────────────────────────────────
  console.log('\nLayer 5 — the envelope is ours:');
  {
    const s = store({ lifetimeMs: 120_000 });
    const { challenge, message, nonce } = s.issue();
    const keys = Object.keys(JSON.parse(message));
    check('5.1 exactly the 7 API fields', keys.length === 7 &&
      ['audience', 'chain', 'challenge', 'domain', 'expires_at_ms', 'issued_at_ms', 'purpose'].every((k) => keys.includes(k)));
    check('5.2 keys sorted, no whitespace', JSON.stringify(keys) === JSON.stringify([...keys].sort()) && !/\s/.test(message));
    check('5.3 audience = configured recipient; lifetime = 120 s', challenge.audience === AUD && challenge.expires_at_ms - challenge.issued_at_ms === 120_000);
    check('5.4 challenge is 32-byte hex', /^[0-9a-f]{64}$/.test(challenge.challenge));
    check('5.4b nonce is 32 bytes, canonical base64 (the API pattern)', /^[A-Za-z0-9+/]{43}=$/.test(nonce) && Buffer.from(nonce, 'base64').length === 32);
    check('5.4c each challenge gets its own nonce', s.issue().nonce !== nonce);

    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const pretty = JSON.stringify(JSON.parse(message), null, 1); // same content, different spelling
    const r1 = await verify(s, lookup, challenge.challenge, await alice.sign(pretty, AUD, nonce));
    check('5.5 same content, re-spelled envelope → UNAUTHORIZED/signature', r1.ok === false && r1.reason === 'signature');

    const tampered = canonicalJson({ ...challenge, expires_at_ms: challenge.expires_at_ms + 3_600_000 });
    const r2 = await verify(s, lookup, challenge.challenge, await alice.sign(tampered, AUD, nonce));
    check('5.6 envelope with an extended expiry → UNAUTHORIZED/signature', r2.ok === false && r2.reason === 'signature');

    // A caller-supplied message field is simply not part of the input contract.
    const sig = await alice.sign(pretty, AUD, nonce);
    const r3 = await verifyAgentIdentity({ store: s, lookup }, { challenge: challenge.challenge, signature: sig, message: pretty });
    check('5.7 extra caller `message` is ignored — the stored one is verified', r3.ok === false && r3.reason === 'signature');
  }

  // ── 6. wire shapes ──────────────────────────────────────────────────────────
  console.log('\nLayer 6 — wire shapes:');
  {
    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const good = await alice.sign(message, AUD, nonce);
    const t = async (o) => verify(s, lookup, challenge.challenge, { ...good, ...o });
    check('6.1 31-byte nonce → nonce_format', (await t({ nonce: randomBytes(31).toString('base64') })).reason === 'nonce_format');
    check('6.2 nonce not base64 → nonce_format', (await t({ nonce: 'not base64!!' })).reason === 'nonce_format');
    check('6.3 signature as hex (the retired api.sign format) → signature_format',
      (await t({ signature: Buffer.from(good.signature, 'base64').toString('hex') })).reason === 'signature_format');
    check('6.4 truncated base64 signature → signature_format', (await t({ signature: good.signature.slice(0, 84) })).reason === 'signature_format');
    check('6.5 secp256k1-prefixed key → public_key', (await t({ public_key: 'secp256k1:' + 'z'.repeat(40) })).reason === 'public_key');
    check('6.6 garbage key → public_key', (await t({ public_key: 'ed25519:0OIl' })).reason === 'public_key');
    check('6.7 invalid account id (uppercase) → account_id', (await t({ near_account_id: 'Alice.near' })).reason === 'account_id');
    check('6.8 unpadded base64 signature → signature_format', (await t({ signature: good.signature.replace(/=+$/, '') })).reason === 'signature_format');
    check('6.9 the correct signature → ok', (await t({})).ok === true);
  }

  // ── 6b. the nonce is NOVA's ────────────────────────────────────────────────
  console.log('\nLayer 6b — the nonce must be the one NOVA issued:');
  {
    const alice = makeAgent('alice.near');
    const lookup = makeLookup({ keys: [['alice.near', alice.publicKey, 'FullAccess']] });
    const s = store();
    const { challenge, message, nonce } = s.issue();
    const own = await alice.sign(message); // agent backend picked its own nonce
    const r1 = await verify(s, lookup, challenge.challenge, own);
    check('6b.1 signed with another valid nonce → UNAUTHORIZED/nonce_mismatch', r1.ok === false && r1.code === 'UNAUTHORIZED' && r1.reason === 'nonce_mismatch');
    const r2 = await verify(s, lookup, challenge.challenge, { ...own, nonce });
    check('6b.2 same signature, nonce field relabelled to ours → UNAUTHORIZED/signature', r2.ok === false && r2.reason === 'signature');
    check('6b.3 no key lookup for either (no RPC amplification)', lookup.calls.length === 0);
    check('6b.4 challenge not burned', s.check(challenge.challenge).ok === true);
    const other = s.issue();
    const r3 = await verify(s, lookup, challenge.challenge, await alice.sign(message, AUD, other.nonce));
    check('6b.5 the nonce of ANOTHER issued challenge → nonce_mismatch (nonces are per challenge)', r3.ok === false && r3.reason === 'nonce_mismatch');
    const r4 = await verify(s, lookup, challenge.challenge, await alice.sign(message, AUD, nonce));
    check('6b.6 then the right nonce → ok', r4.ok === true);
  }

  // ── 7. store invariants ─────────────────────────────────────────────────────
  console.log('\nLayer 7 — store invariants:');
  {
    const s = store();
    const a = s.issue().challenge.challenge, b = s.issue().challenge.challenge;
    check('7.1 two challenges are distinct', a !== b);
    check('7.2 consume once true, twice false', s.consume(a) === true && s.consume(a) === false);
    check('7.3 unknown consume false', s.consume('cd'.repeat(32)) === false);

    let t = 0;
    const capped = store({ maxOutstanding: 3, now: () => t, lifetimeMs: 1000 });
    capped.issue(); capped.issue(); capped.issue();
    check('7.4 at capacity → issue() returns null (bounded memory)', capped.issue() === null);
    t = 1000;
    check('7.5 after expiry, sweep frees room → issue() works', capped.issue() !== null && capped.size() === 1);

    const throwsFor = (o) => { try { store(o); return false; } catch { return true; } };
    check('7.6 audience intents.near refused', throwsFor({ audience: 'intents.near' }));
    check('7.7 lifetime > 5 min refused', throwsFor({ lifetimeMs: 5 * 60 * 1000 + 1 }));
    check('7.8 invalid audience refused', throwsFor({ audience: 'nova-sdk.com!' }));
  }

  // ── 8. oracle: the API's reference (verbatim pure functions) ────────────────
  console.log('\nLayer 8 — agreement with the API reference (identity.ts):');
  {
    // ═══ VERBATIM from NEAR-Intents-Agent-API/examples support/identity.ts (the native-accounts
    //     relying party, 2026-10-21) — the oracle. Do not "improve". ═══
    function refCanonicalJson(value) {
      return JSON.stringify(
        Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      );
    }
    function borshString(value) {
      const bytes = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      return Buffer.concat([length, bytes]);
    }
    function refNep413Digest(input) {
      if (input.nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
      const tag = Buffer.alloc(4);
      tag.writeUInt32LE(2 ** 31 + 413);
      const payload = Buffer.concat([tag, borshString(input.message), Buffer.from(input.nonce), borshString(input.recipient), Buffer.from([0])]);
      return createHash('sha256').update(payload).digest();
    }
    // ═══════════════════════════════════════════════════════════════════════════

    const s = store();
    const { challenge, message, nonce } = s.issue();
    check('8.1 our envelope == reference canonicalJson(challenge), byte for byte', message === refCanonicalJson(challenge));

    // Independent signer: node:crypto ed25519 (no near-kit) over the REFERENCE digest.
    const independent = () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
      return { pub, pk: 'ed25519:' + base58.encode(pub), sign: (d) => nodeSign(null, d, privateKey) };
    };

    let agree = true;
    for (let i = 0; i < 50; i++) {
      const signer = independent();
      const p = { message: i % 2 ? message : `m-${i}-${'é'.repeat(i)}`, nonce: randomBytes(32), recipient: i % 3 ? AUD : `r${i}.near` };
      const sig = signer.sign(refNep413Digest(p));
      const ok = await verifyNep413Signature(
        { accountId: 'x.near', publicKey: signer.pk, signature: Buffer.from(sig).toString('base64') },
        p, { nonceValidation: 'none' });
      if (!ok) { agree = false; break; }
    }
    check('8.2 near-kit verifies independent signatures over the REFERENCE digest (50 vectors, incl. UTF-8)', agree);

    const signer = independent();
    const implicitId = signer.pub.toString('hex');
    const nb = Buffer.from(nonce, 'base64');
    const r = await verify(s, makeLookup({}), challenge.challenge, {
      near_account_id: implicitId,
      public_key: signer.pk,
      signature: Buffer.from(signer.sign(refNep413Digest({ message, nonce: nb, recipient: AUD }))).toString('base64'),
      nonce,
      recipient: AUD,
    });
    check('8.3 the real module accepts an independent signature over the reference digest', r.ok === true);
    // Pinned divergence: the reference's keyControlsAccount maps ANY viewAccount
    // error to "not on chain" (implicit branch). Ours refuses — asserted in 3b.3 / 4.7.
  }

  // ── 9. a REAL signature from the live API ───────────────────────────────────
  console.log('\nLayer 9 — real capture (api.demo.agentsonintents.com native/near/sign-message, 2026-10-21):');
  {
    const FX = {
      message: '{"audience":"nova-sdk.near","chain":"near","challenge":"4c757728743f3d1a8847176d0d9e33b9e1005a3b69d57f02355485942d33021c","domain":"near-intents-agent-api.identity.v1","expires_at_ms":1792573944395,"issued_at_ms":1792573824395,"purpose":"identity"}',
      recipient: 'nova-sdk.near',
      nonce: 'Y+xnM1ONcyKV1pAsdKnHc1V6CV5hBaGoWMBlwRNQDSU=',
      near_account_id: '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288',
      public_key: 'ed25519:75kTumcoAaAxjemJRMZd8kKdQAbhR4nJAThb7cfQ3Byq',
      signature: '5Oq2CEcEiUM/lKen2H5a6XgVFSTTyOi6VjIgtfAGils8CLQ5owr1wmQGGrGY16zd+kBVgC2NlPi4r2AMX235BQ==',
    };
    const vk = (sig, p = FX) => verifyNep413Signature(
      { accountId: FX.near_account_id, publicKey: FX.public_key, signature: sig },
      { message: p.message, recipient: p.recipient, nonce: Buffer.from(p.nonce, 'base64') }, { nonceValidation: 'none' });
    check('9.1 the live signature verifies over NOVA\'s message + nonce + recipient', await vk(FX.signature));
    check('9.2 it matches the API wire pattern this module requires', /^[A-Za-z0-9+/]{86}==$/.test(FX.signature) && /^[A-Za-z0-9+/]{43}=$/.test(FX.nonce));
    const flipped = Buffer.from(FX.signature, 'base64'); flipped[10] ^= 1;
    check('9.3 one flipped bit → does not verify', !(await vk(flipped.toString('base64'))));
    check('9.4 another nonce → does not verify', !(await vk(FX.signature, { ...FX, nonce: randomBytes(32).toString('base64') })));
    check('9.5 the agent account is implicit: id == hex(public key) (the implicit branch applies)',
      Buffer.from(base58.decode(FX.public_key.slice(8))).toString('hex') === FX.near_account_id);
    check('9.6 the captured envelope is our canonical 7-field shape', canonicalJson(JSON.parse(FX.message)) === FX.message);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  FAILURES:\n${failures.map((f) => `    - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('  ✅ all green');
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });

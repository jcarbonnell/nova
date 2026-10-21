// shade-agent/src/lib/agent-identity.ts
//
// Agent identity sign-in: verifies a NEP-413 signature produced by the NEAR
// Intents Agent API (Agent Connect) through `native/near/sign-message`
// (policy `native.near.sign_message`), against a challenge NOVA issued.
//
// v2 (2026-10-21): the Agent API replaced identity signing (`sign` policy +
// `POST /v1/agents/{id}/sign`, API-chosen nonce, hex signature) with native
// accounts (skills repo commit ab818a7, "native accounts replace identity
// signing"). The relying party now supplies the 32-byte nonce and the API
// returns a base64 signature. Reference: examples repo support/identity.ts
// (loginRequest / verifyLogin). The old hex path is REMOVED, not kept beside.
// Phase-2 identity bridge; parallel to — and fully separate from — browser wallet
// SIWN (§5.11-A). Nothing here touches auth.ts or wallet-nonce.ts.
//
// HOW IT DIFFERS FROM BROWSER SIWN (and why it is a separate verifier)
//   - Freshness lives in BOTH the message (`challenge`, issued + stored here) and
//     the NEP-413 nonce, which NOVA also issues and stores with the challenge. The
//     returned nonce must equal the stored one (as the reference verifyLogin
//     requires). Replay protection keys on `challenge`.
//   - The message is a fixed 7-field canonical JSON envelope that WE build and
//     store. The client never supplies it: verify() signs-checks the STORED
//     message, so a re-spelled or tampered envelope cannot reach the crypto.
//   - Signature and nonce are base64; field names follow the API
//     (near_account_id / public_key / signature / nonce / recipient).
//   - Key control accepts an implicit (64-hex) account that does not exist on
//     chain yet, when its id IS the signing key — exactly as the API's reference
//     verifier (examples/support/identity.ts) does.
//
// DELIBERATE DIVERGENCE FROM THE REFERENCE (fail closed)
//   The reference treats ANY viewAccount error as "account does not exist", so an
//   RPC outage routes an EXISTING implicit account (whose original key may have
//   been rotated out) into the "id == key" branch. Here the key lookup is typed:
//   only a positive UNKNOWN_ACCOUNT answer opens the implicit branch; any other
//   lookup failure is KEY_LOOKUP_UNAVAILABLE and nothing is consumed.
//
// CRYPTO
//   No hand-rolled NEP-413 here. The digest + ed25519 check is near-kit's own
//   verifyNep413Signature — the same tested code browser SIWN uses — called
//   WITHOUT `near` (pure crypto) and with nonceValidation:"none". Key control is
//   done by us via the injected, typed lookup (near-kit's Near.getAccessKey
//   swallows every error into null, which would make the implicit branch fail
//   OPEN on an outage).
//
// ORDERING CONTRACT (same as SIWN): check (non-mutating) → recipient → shapes →
//   signature → key control → consume LAST. A bad signature, a lookup outage or a
//   wrong key never burns an issued challenge.
//
// TESTABILITY: no relative imports (the harness imports this .ts directly under
//   --experimental-strip-types); clock and key lookup are injected.
import { randomBytes } from 'node:crypto';
import { verifyNep413Signature, parsePublicKey, isValidAccountId } from 'near-kit';
export const IDENTITY_DOMAIN = 'near-intents-agent-api.identity.v1';
export const INTENTS_CONTRACTS = ['intents.near', 'intents.far'];
export const DEFAULT_LIFETIME_MS = 120_000; // 2 min
export const MAX_LIFETIME_MS = 5 * 60 * 1000; // the API's ceiling
export const DEFAULT_MAX_OUTSTANDING = 10_000; // memory bound (public proxy route)
/** Canonical JSON: keys sorted, no whitespace. Byte-identical to the API's. */
export function canonicalJson(value) {
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
export class AgentChallengeStore {
    records = new Map();
    audience;
    lifetimeMs;
    maxOutstanding;
    now;
    constructor(opts) {
        if (!opts.audience || !isValidAccountId(opts.audience)) {
            throw new Error('agent identity audience must be a valid NEAR account id');
        }
        if (INTENTS_CONTRACTS.includes(opts.audience)) {
            throw new Error('agent identity audience must not be a NEAR Intents contract');
        }
        const lifetime = opts.lifetimeMs ?? DEFAULT_LIFETIME_MS;
        if (!(lifetime > 0 && lifetime <= MAX_LIFETIME_MS)) {
            throw new Error(`challenge lifetime must be in (0, ${MAX_LIFETIME_MS}] ms`);
        }
        this.audience = opts.audience;
        this.lifetimeMs = lifetime;
        this.maxOutstanding = opts.maxOutstanding ?? DEFAULT_MAX_OUTSTANDING;
        this.now = opts.now ?? Date.now;
    }
    /** Drop every expired record (consumed or not). */
    sweep() {
        const t = this.now();
        for (const [k, r] of this.records)
            if (t >= r.expiresAt)
                this.records.delete(k);
    }
    /**
     * Issue a fresh challenge. Returns null when the store is full even after a
     * sweep (the route maps that to 503) — bounded memory behind a public route.
     */
    issue() {
        if (this.records.size >= this.maxOutstanding)
            this.sweep();
        if (this.records.size >= this.maxOutstanding)
            return null;
        let hex = randomBytes(32).toString('hex');
        while (this.records.has(hex))
            hex = randomBytes(32).toString('hex');
        const issuedAt = this.now();
        const challenge = {
            domain: IDENTITY_DOMAIN,
            purpose: 'identity',
            chain: 'near',
            audience: this.audience,
            challenge: hex,
            issued_at_ms: issuedAt,
            expires_at_ms: issuedAt + this.lifetimeMs,
        };
        const message = canonicalJson(challenge);
        const nonce = randomBytes(32).toString('base64');
        this.records.set(hex, { message, nonce, expiresAt: challenge.expires_at_ms, consumed: false });
        return { challenge, message, nonce };
    }
    /** Non-mutating. Call BEFORE verification. Expired = now >= expires_at_ms (as the API). */
    check(hex) {
        const r = this.records.get(hex);
        if (!r)
            return { ok: false, reason: 'unknown' };
        if (r.consumed)
            return { ok: false, reason: 'consumed' };
        if (this.now() >= r.expiresAt)
            return { ok: false, reason: 'expired' };
        return { ok: true, message: r.message, nonce: r.nonce };
    }
    /** Call ONLY after full success. Re-checks freshness. Consumed records are kept until expiry so a replay reports 'consumed'. */
    consume(hex) {
        const r = this.records.get(hex);
        if (!r || r.consumed || this.now() >= r.expiresAt)
            return false;
        r.consumed = true;
        return true;
    }
    size() {
        return this.records.size;
    }
}
const HEX64 = /^[0-9a-f]{64}$/;
const SIG_B64 = /^[A-Za-z0-9+/]{86}==$/; // 64 bytes, canonical base64 (the API's wire pattern)
/** Strict base64 → exactly 32 bytes, or null. Rejects non-canonical spellings. */
function decodeNonce(b64) {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
        return null;
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== b64)
        return null;
    return new Uint8Array(bytes);
}
export async function verifyAgentIdentity(deps, input) {
    const { store, lookup } = deps;
    const sig = input.signature;
    const deny = (reason) => ({ ok: false, code: 'UNAUTHORIZED', reason });
    // 1. challenge: issued, unconsumed, fresh (non-mutating)
    const c = store.check(input.challenge);
    if (!c.ok)
        return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: c.reason };
    // 2. recipient binding
    if (sig.recipient !== store.audience)
        return deny('recipient');
    // 3. shapes
    if (!isValidAccountId(sig.near_account_id))
        return deny('account_id');
    let pk;
    try {
        pk = parsePublicKey(sig.public_key);
    }
    catch {
        return deny('public_key');
    }
    if (pk.keyType !== 0 || pk.data.length !== 32)
        return deny('public_key');
    if (!SIG_B64.test(sig.signature) || Buffer.from(sig.signature, 'base64').toString('base64') !== sig.signature) {
        return deny('signature_format');
    }
    const nonce = decodeNonce(sig.nonce);
    if (!nonce)
        return deny('nonce_format');
    // the nonce must be the one NOVA issued with this challenge
    if (sig.nonce !== c.nonce)
        return deny('nonce_mismatch');
    // 4. signature over the STORED message + STORED nonce (near-kit, pure crypto, no key lookup)
    const sigOk = await verifyNep413Signature({
        accountId: sig.near_account_id,
        publicKey: sig.public_key,
        signature: sig.signature,
    }, { message: c.message, recipient: store.audience, nonce }, { nonceValidation: 'none' });
    if (!sigOk)
        return deny('signature');
    // 5. key control (typed; fail closed on anything indefinite)
    let k;
    try {
        k = await lookup(sig.near_account_id, sig.public_key);
    }
    catch {
        return { ok: false, code: 'KEY_LOOKUP_UNAVAILABLE', reason: 'lookup_failed' };
    }
    if (k.kind === 'access_key') {
        if (k.permission !== 'FullAccess')
            return deny('function_call_key');
    }
    else if (k.kind === 'no_account') {
        const implicitMatch = HEX64.test(sig.near_account_id) && Buffer.from(pk.data).toString('hex') === sig.near_account_id;
        if (!implicitMatch)
            return deny('account_not_found');
    }
    else if (k.kind === 'no_access_key') {
        return deny('key_not_on_account');
    }
    else {
        return { ok: false, code: 'KEY_LOOKUP_UNAVAILABLE', reason: 'lookup_shape' };
    }
    // 6. consume LAST
    if (!store.consume(input.challenge)) {
        return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: 'consume_failed' };
    }
    return { ok: true, account_id: sig.near_account_id, public_key: sig.public_key };
}

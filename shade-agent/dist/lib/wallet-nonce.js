// shade-agent/src/lib/wallet-nonce.ts
//
// Shade-owned nonce store for wallet (NEP-413 SIWN) sign-in.
//
// WHY THIS EXISTS
// near-kit's verifyNep413Signature runs in `nonceValidation: "none"` mode for
// NOVA (see §5.11 / message-signing decision): it treats the 32-byte nonce as
// opaque and performs NO expiry or replay check. Its own docs are explicit —
// "You are then responsible for validating the nonce and preventing replay
// attacks yourself." THIS MODULE IS THAT RESPONSIBILITY.
//
// SCOPE (deliberately minimal, confirmed for Item 1)
//   - In-memory Map on a single CVM. No KV, no persistence.
//   - Lost-on-restart is harmless: an unused 15-min nonce surviving a restart
//     buys an attacker nothing, and the client simply re-requests one.
//   - Single process → no cross-process/locking concerns.
//
// THE ORDERING CONTRACT (the subtle, security-load-bearing part)
//   check  → does NOT mutate. Answers "is this nonce issued, unconsumed, fresh?"
//   consume→ marks a nonce used. MUST be called only AFTER the signature has
//            been verified, so a bad signature cannot burn a victim's issued
//            nonce (a griefing vector). Hence: check-first, consume-LAST.
//   The route calls checkNonce() before signature verification and
//   consumeNonce() only on full success. This module keeps the two operations
//   separate precisely so that ordering is expressible.
//
// TESTABILITY
//   The clock is injectable (`now()`), defaulting to Date.now. The harness
//   drives expiry deterministically with no sleeps. This is the one design
//   constraint the harness imposes on this module.
import crypto from 'crypto';
export const NONCE_BYTES = 32;
export const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
export class WalletNonceStore {
    store = new Map();
    ttlMs;
    now;
    constructor(opts = {}) {
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.now = opts.now ?? Date.now;
    }
    /**
     * Issue a fresh, cryptographically-random 32-byte nonce, hex-encoded for
     * transport. Stored as issued+unconsumed. Returns the hex string the client
     * passes to near.signMessage({ nonce }) (after hex-decoding to bytes).
     */
    issueNonce() {
        const nonceHex = crypto.randomBytes(NONCE_BYTES).toString('hex');
        // Collision is astronomically improbable (2^256); a lazy overwrite would
        // silently reset `consumed`, so guard against it explicitly.
        if (this.store.has(nonceHex)) {
            // Re-roll once; if this ever fires, something is very wrong with the RNG.
            return this.issueNonce();
        }
        this.store.set(nonceHex, { issuedAt: this.now(), consumed: false });
        return nonceHex;
    }
    /**
     * Non-mutating validity check. Call BEFORE signature verification.
     * Lazily evicts an expired record it happens to touch (bounded cleanup on
     * the hot path; a full sweep is unnecessary at this scale).
     */
    checkNonce(nonceHex) {
        const rec = this.store.get(nonceHex);
        if (!rec)
            return { ok: false, reason: 'unknown' };
        if (rec.consumed)
            return { ok: false, reason: 'consumed' };
        if (this.now() - rec.issuedAt > this.ttlMs) {
            this.store.delete(nonceHex); // opportunistic eviction
            return { ok: false, reason: 'expired' };
        }
        return { ok: true };
    }
    /**
     * Mark a nonce consumed. Call ONLY AFTER full success (signature verified).
     * Idempotent-safe: re-consuming or consuming an unknown/expired nonce returns
     * false rather than throwing, so the caller can treat "couldn't consume" as a
     * hard auth failure. Re-validates freshness so a nonce that expired between
     * check and consume is not honoured.
     */
    consumeNonce(nonceHex) {
        const rec = this.store.get(nonceHex);
        if (!rec)
            return false;
        if (rec.consumed)
            return false;
        if (this.now() - rec.issuedAt > this.ttlMs) {
            this.store.delete(nonceHex);
            return false;
        }
        rec.consumed = true;
        return true;
    }
    /** Test/introspection helper — number of tracked nonces. Not used in prod. */
    size() {
        return this.store.size;
    }
}

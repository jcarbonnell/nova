// shade-agent/src/lib/auth.ts
//
// All authentication primitives, in one place. Lifted verbatim from the routes.
//
// Three distinct mechanisms live here — do not conflate them:
//
//   1. verifyAuth0Token   — Auth0 RS256 JWT, verified against Auth0's JWKS.
//                           Used for EMAIL users (frontend → Shade).
//   2. verifyToken        — NOVA's self-signed ephemeral token: a NEAR account
//                           signs a payload with its own key; we verify against
//                           the account's ON-CHAIN access keys. Used by
//                           key-management /get_key.
//   3. checkInternalAuth  — the X-Internal-Auth shared-secret gate (v0.3.2 Fix 3).
//                           TRANSPORT auth, not request auth. Fails closed.
//                           Was duplicated in both route files (Step 4 carry).
//   4. verifyWalletSignin — NEP-413 "Sign in with NEAR" (SIWN), v0.5 §5.11-A.
//                           A wallet signs a Shade-issued nonce; verified via
//                           near-kit's verifyNep413Signature (which also checks
//                           the signing key is an on-chain FULL-ACCESS key — the
//                           same on-chain-key invariant as (2), now library-
//                           provided). Self-custody: NOVA never holds the key.
//                           Nonce lifecycle is Shade-owned (wallet-nonce.ts).
//
// (1) and (2) are the "two parallel auth paths" the roadmap (§8.7) flags for
// convergence in v0.5's better-near-auth rework. They are NOT unified here.
//
// STEP 8 (observability) — LOGGING ONLY; no verification logic changed.
//   verifyToken previously logged a RAW NEAR account id (user_id) on four
//   distinct failure paths, plus a raw exception object. Per roadmap §8:
//   "never log emails, raw account IDs, tokens, private keys, wallet IDs."
//   All now go through log(), which hashes `user_id` by construction and scrubs
//   secret patterns out of every string (incl. the `?apiKey=` that NEAR_RPC_URL
//   will carry once 7.1's FastNear key lands — an exception echoing the request
//   URL would otherwise publish it).
//   Also removed: per-request debug breadcrumbs (payload length, timestamp
//   comparison, "Nonce valid") that shipped to production as console noise.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';
import { Near, verifyNep413Signature } from 'near-kit';
import { WalletNonceStore } from './wallet-nonce.js';
import { NEAR_RPC_URL } from './config.js';
import { getRpcUrl, viewFunction } from './near.js';
import { log } from './logger.js';
import { ApiError } from './errors.js';
// ────────────────────────────────────────────────
// 1. Auth0 (email users)
// ────────────────────────────────────────────────
let JWKS_CLIENT = null;
function getJwksClient() {
    if (!JWKS_CLIENT) {
        const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
        if (!AUTH0_DOMAIN)
            throw new Error('AUTH0_DOMAIN required');
        JWKS_CLIENT = jwksClient({
            jwksUri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
            cache: true,
            cacheMaxAge: 86400000,
        });
    }
    return JWKS_CLIENT;
}
function getKey(header, callback) {
    getJwksClient().getSigningKey(header.kid, (err, key) => {
        callback(err || null, key?.getPublicKey());
    });
}
export async function verifyAuth0Token(token) {
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-3000.dstack-prod5.phala.network';
    if (!AUTH0_DOMAIN)
        throw new Error('AUTH0_DOMAIN required');
    return new Promise((resolve, reject) => {
        const decoded = jwt.decode(token, { complete: true });
        if (!decoded?.payload)
            return reject(new Error('Invalid token format'));
        const validAudiences = [
            AUTH0_AUDIENCE,
            process.env.AUTH0_CLIENT_ID,
        ].filter(Boolean);
        jwt.verify(token, getKey, { audience: validAudiences, issuer: `https://${AUTH0_DOMAIN}/`, algorithms: ['RS256'] }, (err, verified) => {
            if (err)
                return reject(err);
            const payload = verified;
            const email = payload['email'] ||
                payload[`${AUTH0_AUDIENCE}/email`];
            const sub = payload.sub ||
                payload[`${AUTH0_AUDIENCE}/sub`];
            if (!email || !sub)
                return reject(new Error('Missing claims'));
            resolve({ email, sub });
        });
    });
}
export function verifyNovaSession(token) {
    const secret = process.env.SESSION_TOKEN_SECRET;
    const issuer = process.env.SESSION_TOKEN_ISSUER;
    const audience = process.env.SESSION_TOKEN_AUDIENCE;
    // Misconfiguration must fail closed, not fall through to an unverified path.
    if (!secret || !issuer || !audience) {
        log('error', 'nova_session_verify_misconfigured');
        throw new ApiError(500, 'SESSION_VERIFY_MISCONFIGURED', 'Session verification not configured');
    }
    let payload;
    try {
        // HS256 ONLY — never allow alg downgrade. aud/iss/exp enforced by the lib.
        const verified = jwt.verify(token, secret, {
            algorithms: ['HS256'],
            issuer,
            audience,
        });
        if (typeof verified === 'string') {
            throw new Error('Unexpected string payload');
        }
        payload = verified;
    }
    catch (e) {
        // Scrubbed by the logger; carries no token bytes.
        log('warn', 'nova_session_verify_failed', {
            reason: e instanceof Error ? e.name : 'unknown',
        });
        throw new ApiError(401, 'INVALID_SESSION', 'Invalid or expired session');
    }
    if (payload.type !== 'nova_session') {
        log('warn', 'nova_session_verify_failed', { reason: 'wrong_type' });
        throw new ApiError(401, 'INVALID_SESSION', 'Invalid or expired session');
    }
    const account_id = payload.account_id;
    const subject = payload.sub;
    if (typeof account_id !== 'string' || !account_id || typeof subject !== 'string' || !subject) {
        log('warn', 'nova_session_verify_failed', { reason: 'missing_claims' });
        throw new ApiError(401, 'INVALID_SESSION', 'Invalid or expired session');
    }
    return { account_id, subject };
}
// ────────────────────────────────────────────────
// 2. NOVA ephemeral token (NEAR-account self-signed)
// ────────────────────────────────────────────────
/**
 * v0.3.2 Fix 6: NEVER trust the caller-supplied signing key.
 * We always fetch the account's on-chain access keys and verify the signature
 * against that set. `signing_pk_b58`, if present, is a HINT used to narrow which
 * on-chain key to prefer; it must itself match an on-chain key or the token is
 * rejected. Multi-key accounts are handled (the old code only checked the first).
 */
export async function verifyToken(token, contractId, network) {
    try {
        const [payloadB64, sigHex] = token.split('.');
        if (!payloadB64 || !sigHex) {
            log('warn', 'token_verify_failed', { reason: 'malformed_token' });
            return { valid: false };
        }
        const payloadBytes = Buffer.from(payloadB64, 'base64');
        if (payloadBytes.length === 0) {
            log('warn', 'token_verify_failed', { reason: 'empty_payload' });
            return { valid: false };
        }
        const payloadStr = payloadBytes.toString('utf-8');
        const payload = JSON.parse(payloadStr);
        const { group_id, user_id, nonce, timestamp, signing_pk_b58 } = payload;
        if (!group_id || !user_id || !nonce || !timestamp) {
            log('warn', 'token_verify_failed', { reason: 'missing_payload_fields' });
            return { valid: false };
        }
        // Timestamp freshness (payload is ns; compare against ns)
        const timestampStr = timestamp.toString();
        const tsBig = BigInt(timestampStr);
        const nowMs = Date.now();
        const nowNs = BigInt(nowMs) * 1000000n;
        const fiveMinNs = 300000000000n;
        if (tsBig > nowNs + fiveMinNs || tsBig < nowNs - fiveMinNs) {
            // Skew magnitude is diagnostic and carries no PII.
            log('warn', 'token_verify_failed', {
                reason: 'timestamp_out_of_window',
                skew_ms: Number((tsBig - nowNs) / 1000000n),
                user_id,
            });
            return { valid: false };
        }
        // Nonce must be unused (contract-enforced)
        const nonceValid = await viewFunction(getRpcUrl(network), contractId, 'get_nonce_validity', { group_id, user_id, nonce });
        if (!nonceValid) {
            log('warn', 'token_verify_failed', { reason: 'nonce_invalid_or_used', user_id, group_id });
            return { valid: false };
        }
        const rpcUrl = getRpcUrl(network);
        const rpcRes = await axios.post(rpcUrl, {
            jsonrpc: '2.0',
            id: 'dontcare',
            method: 'query',
            params: {
                request_type: 'view_access_key_list',
                finality: 'final',
                account_id: user_id,
            },
        });
        if (rpcRes.status !== 200) {
            log('warn', 'token_verify_failed', {
                reason: 'access_key_rpc_error',
                status: rpcRes.status,
                // Scrubbed by the logger: RPC error text can echo the request URL, which
                // carries ?apiKey= once the FastNear key is configured.
                rpc_error: rpcRes.data?.error?.message || 'unknown',
            });
            return { valid: false };
        }
        const keys = rpcRes.data.result?.keys || [];
        if (keys.length === 0) {
            log('warn', 'token_verify_failed', { reason: 'no_access_keys', user_id });
            return { valid: false };
        }
        const ed25519Keys = keys
            .map(k => k.public_key)
            .filter(pk => pk.startsWith('ed25519:'));
        if (ed25519Keys.length === 0) {
            log('warn', 'token_verify_failed', { reason: 'no_ed25519_key', user_id });
            return { valid: false };
        }
        // A caller-supplied hint MUST be one of the on-chain keys.
        if (signing_pk_b58) {
            const hintFull = `ed25519:${signing_pk_b58}`;
            if (!ed25519Keys.includes(hintFull)) {
                log('warn', 'token_verify_failed', { reason: 'hint_key_not_onchain', user_id });
                return { valid: false };
            }
        }
        // Verify against each candidate on-chain key; accept if any matches.
        const sigBytes = Buffer.from(sigHex, 'hex');
        let userPkBytes = null;
        for (const pk of ed25519Keys) {
            const candidate = bs58.decode(pk.slice(8)); // strip "ed25519:"
            if (candidate.length !== 32)
                continue;
            if (await ed25519.verifyAsync(sigBytes, payloadBytes, candidate)) {
                userPkBytes = candidate;
                break;
            }
        }
        if (!userPkBytes) {
            log('warn', 'token_verify_failed', { reason: 'signature_no_onchain_key_match', user_id });
            return { valid: false };
        }
        return { valid: true, user_id, group_id, nonce, timestamp: Number(timestamp) };
    }
    catch (e) {
        // The exception may carry the RPC URL (=> the FastNear apiKey) or token
        // fragments. The logger scrubs known secret patterns out of both fields.
        log('error', 'token_verify_error', {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
        });
        return { valid: false };
    }
}
// ────────────────────────────────────────────────
// 3. Internal gate (v0.3.2 Fix 3)
// ────────────────────────────────────────────────
/**
 * The Shade Agent's HTTPS endpoint is PUBLIC on Phala. Only MCP and the
 * frontend's server-side routes may reach key operations; both hold
 * INTERNAL_API_SECRET. SDKs never call these routes directly (they go via MCP
 * /tools/*). Health endpoints are exempt so liveness probes still work.
 *
 * FAILS CLOSED: a missing or malformed secret rejects everything.
 * Timing-safe comparison.
 */
export function checkInternalAuth(provided) {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
        log('error', 'internal_auth_misconfigured');
        return false; // fail closed
    }
    if (!provided)
        return false;
    const a = Buffer.from(secret, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length)
        return false;
    return crypto.timingSafeEqual(a, b);
}
// ════════════════════════════════════════════════════════════════════════════
// 4. Wallet SIWN (NEP-413 self-custody) — v0.5 §5.11-A
// ════════════════════════════════════════════════════════════════════════════
/**
 * NOVA's NEP-413 recipient. Binds a signature to NOVA: a signature captured by
 * another dapp (different recipient) cannot authenticate here. This is the
 * human-legible identity the wallet DISPLAYS in its signing prompt, and is
 * stable across the §5.12 CVM-URL churn (unlike the Phala audience). Aligns with
 * the better-near-auth `recipient` convention adopted in §5.11-B.
 */
export const WALLET_SIWN_RECIPIENT = 'nova-sdk.com';
/**
 * Process-lifetime nonce store for wallet sign-in. In-memory, single-CVM.
 * Lost-on-restart is harmless: an unused 15-min nonce surviving a restart buys
 * an attacker nothing, and the client simply re-requests. Exported so the
 * /rpc/wallet/nonce and /rpc/wallet/verify routes share ONE store instance.
 */
export const walletNonceStore = new WalletNonceStore();
/**
 * Lazily-built near-kit client used ONLY for the on-chain full-access-key check
 * inside verifyNep413Signature. It performs a read (view_access_key via
 * getAccessKey); it never signs.
 *
 * RPC WIRING — matches Shade's existing convention exactly:
 *   config.ts's NEAR_RPC_URL already carries the FastNear key as a `?apiKey=`
 *   query param (that is what logger.ts's scrubber redacts). near-kit stores the
 *   rpcUrl verbatim and sends NO Authorization header, so passing that URL is
 *   all that's needed — the read rides the same fast path as viewFunction. We do
 *   NOT use the `Bearer` header form: that was MCP's py_near-specific workaround
 *   (py_near hardcodes `Authorization: Bearer py-near`, which FastNear honours
 *   over the query param). Shade's axios/near-kit path has no such collision.
 *
 * Mainnet-only by design: wallet self-custody targets the mainnet contract; a
 * testnet wallet path is out of scope for §5.11-A. (Hence NEAR_RPC_URL, the
 * mainnet endpoint, not getRpcUrl(network).)
 */
let WALLET_VERIFIER_NEAR = null;
function getWalletVerifierNear() {
    if (WALLET_VERIFIER_NEAR)
        return WALLET_VERIFIER_NEAR;
    WALLET_VERIFIER_NEAR = new Near({
        network: 'mainnet',
        rpcUrl: NEAR_RPC_URL, // from config.ts; carries ?apiKey= if configured
    });
    return WALLET_VERIFIER_NEAR;
}
/**
 * Issue a fresh server-side nonce for wallet sign-in. Thin wrapper over the
 * shared store so the router doesn't reach into the store directly (symmetric
 * with verifyWalletSignin). Returns 32-byte hex.
 */
export function issueWalletNonce() {
    return walletNonceStore.issueNonce();
}
/**
 * Verify a NEP-413 wallet sign-in.
 *
 * TWO-LAYER, check-first / consume-LAST (the security-load-bearing ordering):
 *
 *   1. Shade nonce validity (non-mutating) — near-kit does NONE of this under
 *      `nonceValidation:"none"`, so it is ours. Fails → UNAUTHORIZED_NONCE_REPLAY.
 *   2. near-kit verifyNep413Signature({near, nonceValidation:"none"}) — one
 *      boolean covering signature + recipient + on-chain FULL-ACCESS key.
 *      Fails → UNAUTHORIZED. The nonce is NOT consumed on this path, so a bad
 *      signature cannot burn a victim's issued nonce (griefing guard).
 *   3. consume the nonce — ONLY after full success.
 *
 * The signature is over a message the CLIENT chose to display; we do not
 * constrain its text (near-kit binds security via recipient + nonce, not the
 * human-readable message). `signedMessage.accountId` is the authenticated
 * identity on success.
 *
 * @param signedMessage  near-kit SignedMessage { accountId, publicKey, signature }
 * @param message        the human-readable message that was signed (echoed back
 *                       by the client; must match what the wallet signed)
 * @param nonceHex       the Shade-issued nonce (hex), as returned by /nonce
 */
export async function verifyWalletSignin(signedMessage, message, nonceHex) {
    try {
        // Layer 1 — nonce validity (Shade-owned). Non-mutating.
        const nonceCheck = walletNonceStore.checkNonce(nonceHex);
        if (!nonceCheck.ok) {
            log('warn', 'wallet_signin_failed', {
                reason: `nonce_${nonceCheck.reason}`,
                // account_id is hashed by the logger; safe to include for correlation.
                user_id: signedMessage.accountId,
            });
            return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: nonceCheck.reason };
        }
        // Layer 2 — crypto + recipient + on-chain full-access key (near-kit).
        let sigValid = false;
        try {
            sigValid = await verifyNep413Signature(signedMessage, {
                message,
                recipient: WALLET_SIWN_RECIPIENT,
                nonce: Buffer.from(nonceHex, 'hex'),
            }, {
                near: getWalletVerifierNear(),
                nonceValidation: 'none', // Shade owns nonce/replay; opaque bytes.
            });
        }
        catch (e) {
            // near-kit throws only on infra faults (e.g. RPC unreachable), not on a
            // bad signature (that returns false). Treat as auth failure, log scrubbed.
            log('error', 'wallet_signin_verify_error', {
                message: e instanceof Error ? e.message : String(e),
                stack: e instanceof Error ? e.stack : undefined,
            });
            return { ok: false, code: 'UNAUTHORIZED', reason: 'verify_error' };
        }
        if (!sigValid) {
            // Nonce intentionally NOT consumed — bad sig must not burn it.
            log('warn', 'wallet_signin_failed', {
                reason: 'signature_invalid',
                user_id: signedMessage.accountId,
            });
            return { ok: false, code: 'UNAUTHORIZED', reason: 'signature_invalid' };
        }
        // Layer 3 — consume ONLY after full success.
        const consumed = walletNonceStore.consumeNonce(nonceHex);
        if (!consumed) {
            // Lost a race (expired or double-submitted between check and consume).
            log('warn', 'wallet_signin_failed', {
                reason: 'nonce_consume_failed',
                user_id: signedMessage.accountId,
            });
            return { ok: false, code: 'UNAUTHORIZED_NONCE_REPLAY', reason: 'consume_failed' };
        }
        log('info', 'wallet_signin_ok', { user_id: signedMessage.accountId });
        return { ok: true, account_id: signedMessage.accountId, public_key: signedMessage.publicKey };
    }
    catch (e) {
        log('error', 'wallet_signin_error', {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
        });
        return { ok: false, code: 'UNAUTHORIZED', reason: 'internal' };
    }
}

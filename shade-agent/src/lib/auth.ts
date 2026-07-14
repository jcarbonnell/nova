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
//
// (1) and (2) are the "two parallel auth paths" the roadmap (§8.7) flags for
// convergence in v0.5's better-near-auth rework. They are NOT unified here.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { VerifyErrors, JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { getRpcUrl, viewFunction } from './near.js';
import { log } from './logger.js';

// ────────────────────────────────────────────────
// 1. Auth0 (email users)
// ────────────────────────────────────────────────

let JWKS_CLIENT: jwksClient.JwksClient | null = null;

function getJwksClient(): jwksClient.JwksClient {
  if (!JWKS_CLIENT) {
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    if (!AUTH0_DOMAIN) throw new Error('AUTH0_DOMAIN required');
    JWKS_CLIENT = jwksClient({
      jwksUri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 86400000,
    });
  }
  return JWKS_CLIENT;
}

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  getJwksClient().getSigningKey(header.kid, (err, key) => {
    callback(err || null, key?.getPublicKey());
  });
}

export async function verifyAuth0Token(token: string): Promise<{ email: string; sub: string }> {
  const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
  const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://nova-mcp.fastmcp.app';

  if (!AUTH0_DOMAIN) throw new Error('AUTH0_DOMAIN required');

  return new Promise((resolve, reject) => {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded?.payload) return reject(new Error('Invalid token format'));

    const validAudiences = [
      AUTH0_AUDIENCE,
      process.env.AUTH0_CLIENT_ID,
    ].filter(Boolean) as [string, ...string[]];

    jwt.verify(
      token,
      getKey,
      { audience: validAudiences, issuer: `https://${AUTH0_DOMAIN}/`, algorithms: ['RS256'] },
      (err: VerifyErrors | null, verified: JwtPayload | string | undefined) => {
        if (err) return reject(err);
        const payload = verified as JwtPayload;
        const email =
          (payload['email'] as string | undefined) ||
          (payload[`https://${AUTH0_AUDIENCE}/email`] as string | undefined);
        const sub =
          payload.sub ||
          (payload[`https://${AUTH0_AUDIENCE}/sub`] as string | undefined);
        if (!email || !sub) return reject(new Error('Missing claims'));
        resolve({ email, sub });
      }
    );
  });
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
export async function verifyToken(
  token: string,
  contractId: string,
  network: string,
): Promise<{ valid: boolean; user_id?: string; group_id?: string; nonce?: string; timestamp?: number }> {
  try {
    const [payloadB64, sigHex] = token.split('.');
    if (!payloadB64 || !sigHex) {
      console.error('Token verify: Invalid format (missing . separator)');
      return { valid: false };
    }

    const payloadBytes = Buffer.from(payloadB64, 'base64');
    if (payloadBytes.length === 0) {
      console.error('Token verify: Empty payload');
      return { valid: false };
    }

    const payloadStr = payloadBytes.toString('utf-8');
    console.log('Token verify: Payload str len', payloadStr.length);

    const payload = JSON.parse(payloadStr);
    const { group_id, user_id, nonce, timestamp, signing_pk_b58 } = payload;
    if (!group_id || !user_id || !nonce || !timestamp) {
      console.log('Token verify: Missing payload fields');
      return { valid: false };
    }

    // Timestamp freshness (payload is ns; compare against ns)
    const timestampStr = timestamp.toString();
    const tsBig = BigInt(timestampStr);
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * 1000000n;
    const fiveMinNs = 300000000000n;
    if (tsBig > nowNs + fiveMinNs || tsBig < nowNs - fiveMinNs) {
      console.error('Token verify: Timestamp invalid', { tsBig: tsBig.toString(), nowNs: nowNs.toString() });
      return { valid: false };
    }
    console.log('Token verify: Timestamp ms', nowMs, 'vs payload', timestamp);

    // Nonce must be unused (contract-enforced)
    const nonceValid = await viewFunction(
      getRpcUrl(network), contractId, 'get_nonce_validity', { group_id, user_id, nonce },
    );
    if (!nonceValid) {
      console.error('Token verify: Nonce invalid/used');
      return { valid: false };
    }
    console.log('Token verify: Nonce valid');

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
      console.error('Token verify: RPC error', rpcRes.status, rpcRes.data?.error?.message || 'Unknown');
      return { valid: false };
    }
    const keys: { public_key: string }[] = rpcRes.data.result?.keys || [];
    if (keys.length === 0) {
      console.error('Token verify: No access keys for', user_id);
      return { valid: false };
    }

    const ed25519Keys = keys
      .map(k => k.public_key)
      .filter(pk => pk.startsWith('ed25519:'));
    if (ed25519Keys.length === 0) {
      console.error('Token verify: No ed25519 key found for', user_id);
      return { valid: false };
    }

    // A caller-supplied hint MUST be one of the on-chain keys.
    if (signing_pk_b58) {
      const hintFull = `ed25519:${signing_pk_b58}`;
      if (!ed25519Keys.includes(hintFull)) {
        console.error('Token verify: signing_pk_b58 not an on-chain key of', user_id);
        return { valid: false };
      }
    }

    // Verify against each candidate on-chain key; accept if any matches.
    const sigBytes = Buffer.from(sigHex, 'hex');
    let userPkBytes: Uint8Array | null = null;
    for (const pk of ed25519Keys) {
      const candidate = bs58.decode(pk.slice(8)); // strip "ed25519:"
      if (candidate.length !== 32) continue;
      if (await ed25519.verifyAsync(sigBytes, payloadBytes, candidate)) {
        userPkBytes = candidate;
        break;
      }
    }
    if (!userPkBytes) {
      console.error('Token verify: Sig does not match any on-chain key of', user_id);
      return { valid: false };
    }

    return { valid: true, user_id, group_id, nonce, timestamp: Number(timestamp) };
  } catch (e) {
    console.error('Token verify error:', e);
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
export function checkInternalAuth(provided: string | undefined): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    log('error', 'internal_auth_misconfigured');
    return false; // fail closed
  }
  if (!provided) return false;
  const a = Buffer.from(secret, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
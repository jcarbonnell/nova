// shade-agent/src/lib/logger.ts
// 
// Structured logging with redaction BY CONSTRUCTION (roadmap step 8).
//
// Redaction is the logger's job, not the caller's. The pre-8.1 pattern relied on
// each call site remembering hashForLog() — which worked in lib/* and failed in
// services/* (raw console.log of email, sub, account_id, keyId). Same reasoning
// as §5.0: a property that depends on every author remembering is not a property.
//
// TWO independent protections:
//   1. FIELD REDACTION — meta keys known to carry PII are replaced by a short
//      hash and renamed `{field}_hash`. Correlation is preserved (same input =>
//      same hash) without the value ever reaching disk.
//   2. SECRET SCRUBBING — every string value (including error messages and
//      stacks, which echo request URLs) has known secret patterns stripped.
//      ⚠️ LOAD-BEARING once 7.1's FastNear key lands: NEAR_RPC_URL will contain
//      `?apiKey=<secret>`, so any logged URL would otherwise publish it to Phala
//      logs. Same class as v0.4 Fix I (creator-key prefix in Vercel logs).

import { hashForLog } from './crypto.js';

/** Field names that must NEVER appear in logs as raw values. */
const PII_FIELDS = new Set([
  'email', 'sub', 'account_id', 'user_id', 'member_id', 'owner',
  'wallet_id', 'private_key', 'public_key', 'api_key', 'auth_token',
  'token', 'access_token', 'session_token', 'secret',
]);

/**
 * Patterns stripped from every logged string.
 * Additive by design — a new secret-bearing URL param goes here, once.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/([?&]apiKey=)[^&\s"']+/gi, '$1[REDACTED]'],        // FastNear (7.1)
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]'],    // Authorization headers
  [/(ed25519:)[A-Za-z0-9+/=]{60,}/g, '$1[REDACTED]'],   // NEAR private keys are 88 chars, public keys 44 chars. This is a conservative 60-char threshold.
];

function scrub(s: string): string {
  return SECRET_PATTERNS.reduce((acc, [re, sub]) => acc.replace(re, sub), s);
}

/**
 * Shallow by design: every current call site passes a flat object. If nested
 * meta is ever needed, make this recursive — do not hand-redact at the call site.
 */
function redact(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(meta)) {
    // Already-hashed fields pass through (wallet_hash, account_id_hash, txHash…).
    if (k.endsWith('_hash') || k === 'txHash') {
      out[k] = v;
      continue;
    }

    if (PII_FIELDS.has(k)) {
      out[`${k}_hash`] = v == null ? null : hashForLog(String(v));
      continue;
    }

    out[k] = typeof v === 'string' ? scrub(v) : v;
  }

  return out;
}

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta?: Record<string, unknown>,
) {
  console[level](JSON.stringify({ 
    ts: new Date().toISOString(), 
    level, 
    event, 
    ...(meta ? redact(meta) : {}), 
  }));
}
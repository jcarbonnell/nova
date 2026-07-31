// shade-agent/src/lib/services/user-keys.ts
//
// The user-key operations, as pure functions. No Hono, no HTTP, no Context.
//
// WHY: these are consumed by TWO adapters — the existing Hono routes and 
// the oRPC procedures. One implementation, two surfaces, so parity is guaranteed.
//
// CONTRACT:
//   - Input is ALREADY VALIDATED (Zod ran in middleware). Services do not re-validate.
//   - Failures throw ApiError. The adapter turns that into a response.
//   - Success returns a plain object — exactly the body the route used to emit.
//   - HTTP concerns (rate limiting by IP, the X-Internal-Auth gate) stay in the
//     adapter. Services must never read a header.
import crypto from 'crypto';
import { encryptBlob, decryptBlob, deriveKey, sha256Hex, hashForLog } from '../crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../kv.js';
import { verifyAuth0Token } from '../auth.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';
const WALLET_DISABLED = {
    code: 'WALLET_AUTH_PENDING_SELF_CUSTODY',
    message: 'Wallet auth disabled pending self-custody migration (v0.5)',
};
// ────────────────────────────────────────────────
// STORE
// ────────────────────────────────────────────────
export async function storeUserKey(input) {
    const { email, account_id, private_key, public_key, network, auth_token, wallet_id } = input;
    log('info', 'store_request', {
        email,
        account_id,
        has_token: !!auth_token,
        wallet_id,
    });
    let verifiedUser;
    if (auth_token) {
        verifiedUser = await verifyAuth0Token(auth_token);
        if (verifiedUser.email !== email)
            throw new ApiError(403, 'EMAIL_MISMATCH', 'Email mismatch');
        log('info', 'store_token_verified', { sub: verifiedUser.sub });
    }
    else if (wallet_id) {
        // DISABLED (v0.4 Fix H): accepted an unauthenticated wallet_id and wrote a
        // keypair under wallet|{id} + account:{id} with no proof of control.
        log('warn', 'store_wallet_branch_rejected', { wallet_hash: hashForLog(wallet_id) });
        throw new ApiError(501, WALLET_DISABLED.code, WALLET_DISABLED.message);
    }
    else {
        throw new ApiError(400, 'AUTH_REQUIRED', 'auth_token or wallet_id required');
    }
    const userData = {
        account_id,
        private_key,
        public_key,
        network,
        wallet_id: wallet_id || null,
        created_at: new Date().toISOString(),
    };
    const encryptedBlob = encryptBlob(Buffer.from(JSON.stringify(userData), 'utf8'));
    const sub = verifiedUser.sub;
    const keyId = sha256Hex(`user:${sub}`);
    // keyId is truncated to avoid anyone fetching a user blob and confirm an account exists.
    log('info', 'store_key_id_computed', { key_id_hash: keyId.slice(0, 12) });
    await storeBlobToKV(keyId, encryptedBlob);
    log('info', 'user_key_stored', { account_id, network });
    // Dual-write: the account: key is what MCP's account-only signing path reads.
    const accountKeyId = sha256Hex(`account:${account_id}`);
    await storeBlobToKV(accountKeyId, encryptedBlob);
    return {
        success: true,
        account_id,
        network,
        wallet_id: wallet_id || null,
        checksum: 'tee-verified',
        key_id: keyId,
    };
}
// ────────────────────────────────────────────────
// RETRIEVE
// ────────────────────────────────────────────────
export async function retrieveUserKey(input) {
    const { email, auth_token, account_id, wallet_id: walletId } = input;
    if (account_id && !email && !auth_token && !walletId) {
        // ACCOUNT-ONLY RETRIEVE — MCP's internal signing path (v0.3.2 Fix 4).
        // Reachable ONLY through the X-Internal-Auth gate. MCP uses this when it must
        // sign a NEAR transaction on a user's behalf, at which point no user token
        // exists (the user authenticated to MCP earlier via session JWT). This branch
        // returns a private key with NO per-user auth, so it MUST remain behind the
        // gate. Audit every use.
        log('warn', 'account_only_retrieve', { account_id_hash: hashForLog(account_id) });
        const accountKeyId = sha256Hex(`account:${account_id}`);
        const encryptedBlob = await getBlobFromKV(accountKeyId);
        if (!encryptedBlob)
            throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
        const userData = JSON.parse(Buffer.from(decryptBlob(encryptedBlob)).toString('utf8'));
        return {
            account_id: userData.account_id,
            private_key: userData.private_key,
            public_key: userData.public_key,
            network: userData.network,
            wallet_id: userData.wallet_id,
            checksum: 'derived-verified',
        };
    }
    let verifiedUser;
    if (email && auth_token) {
        verifiedUser = await verifyAuth0Token(auth_token);
        if (verifiedUser.email !== email)
            throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
    }
    else if (walletId) {
        // DISABLED (v0.3.2 Fix 5). The wallet path derived sub = `wallet|{walletId}`
        // from an unauthenticated assertion. Custodial today; rebuilt as genuine
        // self-custody in v0.5 (§5.11).
        log('warn', 'wallet_retrieve_rejected_pending_self_custody', {
            wallet_hash: hashForLog(walletId),
        });
        throw new ApiError(501, WALLET_DISABLED.code, WALLET_DISABLED.message);
    }
    else {
        throw new ApiError(400, 'AUTH_REQUIRED', 'Missing auth_token (email)');
    }
    const keyId = sha256Hex(`user:${verifiedUser.sub}`);
    const encryptedBlob = await getBlobFromKV(keyId);
    if (!encryptedBlob)
        throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
    const userData = JSON.parse(Buffer.from(decryptBlob(encryptedBlob)).toString('utf8'));
    return {
        account_id: userData.account_id,
        private_key: userData.private_key,
        public_key: userData.public_key,
        network: userData.network,
        wallet_id: userData.wallet_id,
        checksum: 'derived-verified',
    };
}
// ────────────────────────────────────────────────
// CHECK (+ self-healing backfill)
// ────────────────────────────────────────────────
export async function checkAccount(input) {
    const { email, auth_token, wallet_id, account_id } = input;
    log('info', 'check_request', {
        email,
        has_token: !!auth_token,
        wallet_id,
        account_id,
    });
    let verifiedSub;
    if (email && auth_token) {
        try {
            const verified = await verifyAuth0Token(auth_token);
            log('info', 'check_token_verified', { sub: verified.sub });
            if (verified.email !== email) {
                log('warn', 'check_email_mismatch', { email });
                throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
            }
            verifiedSub = verified.sub;
        }
        catch (tokenError) {
            if (tokenError instanceof ApiError)
                throw tokenError;
            // Scrubbed by the logger: Auth0/JWKS errors can echo request URLs.
            log('warn', 'check_token_verification_failed', {
                message: tokenError instanceof Error ? tokenError.message : String(tokenError),
            });
            throw new ApiError(401, 'TOKEN_VERIFICATION_FAILED', 'Token verification failed');
        }
    }
    else if (!wallet_id) {
        throw new ApiError(400, 'AUTH_REQUIRED', 'Missing auth_token (email) or wallet_id (wallet)');
    }
    const sub = verifiedSub || (wallet_id ? `wallet|${wallet_id}` : null);
    if (!sub)
        throw new ApiError(400, 'CANNOT_DERIVE_KEY_ID', 'Cannot derive key id');
    const keyId = sha256Hex(`user:${sub}`);
    log('info', 'check_key_id_computed', { key_id_hash: keyId.slice(0, 12) });
    const blob = await getBlobFromKV(keyId);
    if (!blob) {
        log('info', 'check_account_not_found', { key_id_hash: keyId.slice(0, 12) });
        return { exists: false, account_id: null };
    }
    const userData = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
    log('info', 'check_account_found', { account_id: userData.account_id });
    // SELF-HEALING BACKFILL (v0.4 Fix C).
    // /store dual-writes user:{sub} AND account:{account_id}. Accounts created
    // before that dual-write only have user:{sub}, so MCP's account-only signing
    // path 404s for them. /check is the login path and the only place we hold BOTH
    // a verified sub and the account_id — so heal here. Copy the stored bytes
    // VERBATIM: do NOT decrypt/re-encrypt. A legacy CBC blob stays CBC (still
    // readable via decryptBlob's fallback) and no new crypto risk enters login.
    if (userData.account_id) {
        const accountKeyId = sha256Hex(`account:${userData.account_id}`);
        const existing = await getBlobFromKV(accountKeyId);
        if (!existing) {
            const raw = Array.isArray(blob) ? Buffer.from(blob) : Buffer.from(blob, 'hex');
            await storeBlobToKV(accountKeyId, raw.toString('hex'));
            log('warn', 'account_key_backfilled', {
                account_id_hash: hashForLog(userData.account_id),
            });
        }
    }
    return { exists: true, account_id: userData.account_id };
}
// ────────────────────────────────────────────────
// API KEYS
// ────────────────────────────────────────────────
/**
 * Read the api-hash:{account} blob in either format.
 *   - legacy bare 64-hex  → { v: 0, hash }   (v0 = pre-§5.9 unversioned salt)
 *   - new JSON { v, hash } → as stored (v >= 1)
 * Returns null if no blob exists.
 */
async function readApiKeyRecord(accountId) {
    const hashKeyId = sha256Hex(`api-hash:${accountId}`);
    const blob = await getBlobFromKV(hashKeyId);
    if (!blob)
        return null;
    const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
    // Legacy bare hash → v0 (the pre-§5.9 unversioned key).
    if (/^[0-9a-f]{64}$/i.test(decrypted)) {
        return { v: 0, hash: decrypted };
    }
    try {
        const parsed = JSON.parse(decrypted);
        if (typeof parsed?.v === 'number' && typeof parsed?.hash === 'string') {
            return { v: parsed.v, hash: parsed.hash };
        }
    }
    catch {
        // fall through to corrupt
    }
    throw new ApiError(500, 'API_KEY_BLOB_CORRUPT', 'Stored API key record is unreadable');
}
/**
 * Derive the API key VALUE for account + version.
 *   v === 0 → legacy UNVERSIONED salt `api-key:{account}` (reproduces pre-§5.9 keys)
 *   v >= 1  → versioned salt `api-key:{account}:v{v}`
 *
 * ROTATION NOTE: deriveKey is deterministic, so any version's bytes are
 * re-derivable. Rotation moves the single stored hash forward, so the old key
 * stops VERIFYING (it fails timingSafeEqual against the new stored hash). The
 * property is "old key no longer honored," not "old key unrecoverable." Sound
 * ONLY because there is exactly ONE stored hash per account and rotate
 * OVERWRITES it. Never store a history of valid hashes — that revives old keys.
 */
function deriveApiKeyValue(accountId, version) {
    const salt = version === 0 ? `api-key:${accountId}` : `api-key:${accountId}:v${version}`;
    const bytes = deriveKey(salt, 32);
    return `nova_sk_${Buffer.from(bytes).toString('base64url').slice(0, 43)}`;
}
async function writeApiKeyRecord(accountId, v, hash) {
    const hashKeyId = sha256Hex(`api-hash:${accountId}`);
    await storeBlobToKV(hashKeyId, encryptBlob(Buffer.from(JSON.stringify({ v, hash }), 'utf8')));
}
/** Resolve the target account for an API-key operation. Email+token is the ONLY authenticated path. */
async function resolveApiKeyTarget(input) {
    const { email, auth_token, account_id, wallet_id } = input;
    if (email && auth_token) {
        const verified = await verifyAuth0Token(auth_token);
        if (verified.email !== email)
            throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
        const keyId = sha256Hex(`user:${verified.sub}`);
        const blob = await getBlobFromKV(keyId);
        if (!blob)
            throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'No NOVA account found. Create one first.');
        const userData = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
        return userData.account_id;
    }
    // DISABLED (v0.4 Fixes E/F). CRITICAL: these branches accepted an
    // unauthenticated account assertion and returned a deterministically-derived
    // (i.e. REAL, verifying) API key for it. Chained to session-token Path 0, that
    // was full account takeover. The internal gate is not a sufficient control
    // here — the frontend legitimately holds INTERNAL_API_SECRET and exposed this
    // to the public internet.
    if (account_id || wallet_id) {
        log('warn', 'api_key_unauth_branch_rejected', {
            account_hash: hashForLog((account_id || wallet_id)),
        });
        throw new ApiError(501, WALLET_DISABLED.code, WALLET_DISABLED.message);
    }
    throw new ApiError(400, 'MISSING_FIELDS', 'Missing fields: email+auth_token, account_id, or wallet_id');
}
export async function generateApiKey(input) {
    const targetAccountId = await resolveApiKeyTarget(input);
    const existing = await readApiKeyRecord(targetAccountId);
    // Idempotent: if a key already exists, return the CURRENT version's value.
    // A legacy holder (v0) re-derives their REAL existing key via the unversioned
    // salt — no breakage. Viewing/regenerating must NOT rotate a running agent's key.
    // New accounts start at v1 (versioned from the start).
    const version = existing ? existing.v : 1;
    const apiKey = deriveApiKeyValue(targetAccountId, version);
    // Persist only for brand-new accounts. Legacy v0 holders keep their bare-hash
    // blob untouched until they explicitly rotate — idempotent generate must not
    // mutate storage.
    if (!existing) {
        await writeApiKeyRecord(targetAccountId, version, sha256Hex(apiKey));
    }
    log('info', 'api_key_generated', { account_id: targetAccountId, version });
    return {
        success: true,
        api_key: apiKey,
        account_id: targetAccountId,
        version,
        message: 'Save this key securely — it will not be shown again.',
    };
}
export async function rotateApiKey(input) {
    const targetAccountId = await resolveApiKeyTarget(input);
    const existing = await readApiKeyRecord(targetAccountId);
    // v0 (legacy) → v1 on first rotate, moving the account onto the versioned
    // scheme and invalidating the legacy key. A non-existent key just creates v1.
    const newVersion = existing ? existing.v + 1 : 1;
    const apiKey = deriveApiKeyValue(targetAccountId, newVersion);
    // Single atomic overwrite: the instant this lands, the previous version's hash
    // is gone and the old key stops verifying.
    await writeApiKeyRecord(targetAccountId, newVersion, sha256Hex(apiKey));
    log('warn', 'api_key_rotated', {
        account_id: targetAccountId,
        from_version: existing?.v ?? -1,
        to_version: newVersion,
    });
    return {
        success: true,
        api_key: apiKey,
        account_id: targetAccountId,
        version: newVersion,
        message: 'Key rotated. The previous key is now invalid. Save this key securely.',
    };
}
export async function hasApiKey(input) {
    const targetAccountId = await resolveApiKeyTarget(input);
    log('info', 'api_key_checked', { account_id: targetAccountId });
    const hashKeyId = sha256Hex(`api-hash:${targetAccountId}`);
    const hashBlob = await getBlobFromKV(hashKeyId);
    return { has_api_key: !!hashBlob, account_id: targetAccountId };
}
export async function verifyApiKey(input) {
    const { api_key, account_id } = input;
    if (!api_key.startsWith('nova_sk_') || api_key.length < 40) {
        return { kind: 'invalid_format' };
    }
    const providedHash = sha256Hex(api_key);
    const record = await readApiKeyRecord(account_id);
    if (!record)
        return { kind: 'no_key_configured' };
    const valid = crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), Buffer.from(providedHash, 'hex'));
    return { kind: 'checked', valid, account_id, network: 'mainnet' };
}

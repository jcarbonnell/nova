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
    console.log('💾 STORE request received:', {
        email: email ? `${email.substring(0, 5)}...` : undefined,
        account_id,
        has_token: !!auth_token,
        wallet_id,
    });
    let verifiedUser;
    if (auth_token) {
        verifiedUser = await verifyAuth0Token(auth_token);
        if (verifiedUser.email !== email)
            throw new ApiError(403, 'EMAIL_MISMATCH', 'Email mismatch');
        console.log('✅ Token verified for STORE, sub:', verifiedUser.sub?.substring(0, 20) + '...');
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
    console.log('🔑 Derived sub for STORE:', sub.substring(0, 30) + '...');
    const keyId = sha256Hex(`user:${sub}`);
    console.log('🔑 Computed keyId for STORE:', keyId);
    await storeBlobToKV(keyId, encryptedBlob);
    console.log('✅ Key stored successfully for account:', account_id);
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
    console.log('🔍 CHECK request received:', {
        email: email ? `${email.substring(0, 5)}...` : undefined,
        has_token: !!auth_token,
        wallet_id,
        account_id,
    });
    let verifiedSub;
    if (email && auth_token) {
        try {
            const verified = await verifyAuth0Token(auth_token);
            console.log('✅ Token verified, sub:', verified.sub?.substring(0, 20) + '...');
            if (verified.email !== email) {
                console.log('❌ Email mismatch');
                throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');
            }
            verifiedSub = verified.sub;
        }
        catch (tokenError) {
            if (tokenError instanceof ApiError)
                throw tokenError;
            console.error('❌ Token verification failed:', tokenError);
            throw new ApiError(401, 'TOKEN_VERIFICATION_FAILED', 'Token verification failed');
        }
    }
    else if (!wallet_id) {
        throw new ApiError(400, 'AUTH_REQUIRED', 'Missing auth_token (email) or wallet_id (wallet)');
    }
    const sub = verifiedSub || (wallet_id ? `wallet|${wallet_id}` : null);
    if (!sub)
        throw new ApiError(400, 'CANNOT_DERIVE_KEY_ID', 'Cannot derive key id');
    console.log('🔑 Derived sub:', sub.substring(0, 30) + '...');
    const keyId = sha256Hex(`user:${sub}`);
    console.log('🔑 Computed keyId:', keyId);
    const blob = await getBlobFromKV(keyId);
    if (!blob) {
        console.log('❌ No blob found in KV for keyId:', keyId);
        return { exists: false, account_id: null };
    }
    console.log('✅ Blob found in KV, decrypting...');
    const userData = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
    console.log('✅ Account found:', userData.account_id);
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
    console.log('🔑 Generating API key for account:', targetAccountId);
    // Deterministic from the master seed. NOTE: no version component — rotation is
    // therefore impossible today. That is what made Fix E a full takeover rather
    // than a nuisance. Versioned derivation lands in v0.5 (§5.9).
    const apiKeyBytes = deriveKey(`api-key:${targetAccountId}`, 32);
    const apiKey = `nova_sk_${Buffer.from(apiKeyBytes).toString('base64url').slice(0, 43)}`;
    const apiKeyHash = sha256Hex(apiKey);
    const hashKeyId = sha256Hex(`api-hash:${targetAccountId}`);
    await storeBlobToKV(hashKeyId, encryptBlob(Buffer.from(apiKeyHash, 'utf8')));
    return {
        success: true,
        api_key: apiKey,
        account_id: targetAccountId,
        message: 'Save this key securely — it will not be shown again.',
    };
}
export async function hasApiKey(input) {
    const targetAccountId = await resolveApiKeyTarget(input);
    console.log('🔍 Checking API key for account:', targetAccountId);
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
    const hashKeyId = sha256Hex(`api-hash:${account_id}`);
    const storedHash = await getBlobFromKV(hashKeyId);
    if (!storedHash)
        return { kind: 'no_key_configured' };
    const storedHashStr = Buffer.from(decryptBlob(storedHash)).toString('utf8');
    const valid = crypto.timingSafeEqual(Buffer.from(storedHashStr, 'hex'), Buffer.from(providedHash, 'hex'));
    return { kind: 'checked', valid, account_id, network: 'mainnet' };
}

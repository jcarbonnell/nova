// shade-agent/src/routes/user-keys.ts - user key management with KV persistence and deterministic derivation
import { Hono } from 'hono';
import crypto, { hkdfSync } from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import * as ed25519 from '@noble/ed25519';
import bs58 from 'bs58';
import axios from 'axios';
// ─────────────────
// Configuration
// ─────────────────
const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://nova-mcp.fastmcp.app';
const SHADE_AGENT_ACCOUNT_ID = process.env.SHADE_AGENT_ACCOUNT_ID;
if (!AUTH0_DOMAIN)
    throw new Error('AUTH0_DOMAIN required');
if (!SHADE_AGENT_ACCOUNT_ID)
    throw new Error('SHADE_AGENT_ACCOUNT_ID required');
if (!/^[0-9a-f]{64}$/i.test(TEE_SECRET))
    throw new Error('TEE_KEY_SECRET must be a 64-char hex string (32 bytes)');
// Initialize JWKS client for Auth0 public key verification
const JWKS_CLIENT = jwksClient({
    jwksUri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
    cache: true,
    cacheMaxAge: 86400000,
});
const BASE62_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// ────────────────────────────────────────────────
// Master Seed & Deterministic Derivation
// ────────────────────────────────────────────────
let masterSeed = null;
// ⚠️  FIRST-DEPLOY SAFETY: After the initial deployment confirms the master seed
// is stored on-chain, set MASTER_SEED_INIT_ALLOWED=false (or remove the env var)
// to prevent accidental re-initialization on subsequent deploys.
const MASTER_SEED_INIT_ALLOWED = process.env.MASTER_SEED_INIT_ALLOWED === 'true';
async function initializeMasterSeedIfNeeded() {
    if (masterSeed)
        return;
    const encryptedBlob = await getBlobFromKV('master-root');
    if (encryptedBlob) {
        masterSeed = decryptBlob(encryptedBlob);
        console.log('Master seed loaded from KV');
        return;
    }
    if (!MASTER_SEED_INIT_ALLOWED) {
        throw new Error('Master seed not found in KV and MASTER_SEED_INIT_ALLOWED is not set. ' +
            'Set MASTER_SEED_INIT_ALLOWED=true on first deploy only, then remove it.');
    }
    // First-time init — runs ONCE when no blob exists and flag is explicitly set
    console.warn('⚠️  Initializing new master seed — this should run ONLY once!');
    const newSeed = crypto.randomBytes(32);
    const encrypted = encryptBlob(newSeed);
    await storeBlobToKV('master-root', encrypted);
    masterSeed = newSeed;
    console.log('Master seed initialized and stored on-chain');
}
function deriveKey(salt, length = 32) {
    if (!masterSeed)
        throw new Error('Master seed not initialized');
    const derived = hkdfSync('sha256', masterSeed, Buffer.from(salt), Buffer.from('nova-v1'), length);
    return new Uint8Array(derived);
}
function encryptBlob(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
    let encrypted = cipher.update(data);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}
function decryptBlob(enc) {
    // Handle raw byte array returned directly from NEAR KV (16-byte IV + ciphertext)
    if (Array.isArray(enc)) {
        const raw = Buffer.from(enc);
        const iv = raw.subarray(0, 16);
        const encrypted = raw.subarray(16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted;
    }
    // Handle legacy hex-string format "ivhex:encryptedhex"
    const [ivStr, encStr] = enc.split(':');
    if (!ivStr || !encStr)
        throw new Error('Invalid encrypted blob format');
    const iv = Buffer.from(ivStr, 'hex');
    const encrypted = Buffer.from(encStr, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted;
}
// ──────────────────────
// KV Contract Helpers
// ──────────────────────
function log(level, event, meta) {
    console[level](JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
}
async function rpcCallWithRetry(rpcUrl, payload, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await axios.post(rpcUrl, payload, { timeout: 10_000 });
            if (res.data.error) {
                const msg = res.data.error.message || res.data.error.cause?.name || JSON.stringify(res.data.error);
                throw new Error(`RPC error: ${msg}`);
            }
            return res.data.result;
        }
        catch (err) {
            const isLast = attempt === retries - 1;
            if (isLast)
                throw err;
            const backoffMs = 1_000 * (attempt + 1);
            log('warn', 'rpc_retry', { attempt: attempt + 1, backoffMs, error: err.message });
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }
    throw new Error('rpcCallWithRetry: exhausted retries without throwing');
}
async function getBlobFromKV(key) {
    const rpcUrl = 'https://rpc.mainnet.near.org'; // or testnet
    const payload = {
        jsonrpc: '2.0',
        id: 'kv-get',
        method: 'query',
        params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: KV_CONTRACT,
            method_name: 'get',
            args_base64: Buffer.from(JSON.stringify({ key })).toString('base64'),
        },
    };
    try {
        const result = await rpcCallWithRetry(rpcUrl, payload);
        if (result?.result && result.result.length > 0) {
            const jsonStr = Buffer.from(result.result).toString('utf8');
            const parsed = JSON.parse(jsonStr);
            if (!parsed || parsed.length === 0)
                return null;
            return parsed;
        }
        return null;
    }
    catch (err) {
        console.error('KV get failed after retries:', err.message);
        return null;
    }
}
// Borsh primitives for manual NEAR transaction serialization
function borshString(s) {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
}
function borshBytes(b) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
}
function borshU64(n) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(n, 0);
    return buf;
}
function borshU128(n) {
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
    buf.writeBigUInt64LE(n >> 64n, 8);
    return buf;
}
// NEAR action enum index 2 = FunctionCall
function encodeFunctionCallAction(methodName, args, gas, deposit) {
    return Buffer.concat([
        Buffer.from([2]),
        borshString(methodName),
        borshBytes(args),
        borshU64(gas),
        borshU128(deposit),
    ]);
}
// Borsh-encoded NEAR Transaction (pre-signature)
function encodeTransaction(signerId, publicKey, nonce, receiverId, blockHash, actions) {
    const actionsCount = Buffer.alloc(4);
    actionsCount.writeUInt32LE(actions.length, 0);
    return Buffer.concat([
        borshString(signerId),
        Buffer.from([0]),
        publicKey,
        borshU64(nonce),
        borshString(receiverId),
        blockHash,
        actionsCount,
        ...actions,
    ]);
}
async function storeBlobToKV(key, encryptedBlob) {
    const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org';
    const signerAccountId = SHADE_AGENT_ACCOUNT_ID;
    // 1. Derive deterministic signer keypair from master seed
    const signerPriv = deriveKey('kv-signer-v1', 32);
    const signerPub = await ed25519.getPublicKeyAsync(signerPriv);
    const signerPubBs58 = `ed25519:${bs58.encode(signerPub)}`;
    // 2. Fetch current nonce + recent block hash for the signer access key
    const accessKeyResult = await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'access-key',
        method: 'query',
        params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: signerAccountId,
            public_key: signerPubBs58,
        },
    });
    const nonce = BigInt(accessKeyResult.nonce) + 1n;
    const blockHash = bs58.decode(accessKeyResult.block_hash);
    // 3. Encode FunctionCall action + full transaction
    const [ivHex, encHex] = encryptedBlob.split(':');
    const rawBytes = Buffer.concat([Buffer.from(ivHex, 'hex'), Buffer.from(encHex, 'hex')]);
    const callArgs = Buffer.from(JSON.stringify({ key, encrypted_blob: Array.from(rawBytes) }));
    const action = encodeFunctionCallAction('store', callArgs, 30000000000000n, 0n);
    const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, KV_CONTRACT, blockHash, [action]);
    // 4. Hash and sign (NEAR signs SHA-256 of the borsh-encoded transaction)
    const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
    const signature = await ed25519.signAsync(txHash, signerPriv);
    // 5. Borsh-encode SignedTransaction = Transaction + Signature
    const signedTx = Buffer.concat([
        txBytes,
        Buffer.from([0]), // Signature enum: 0 = ed25519
        signature, // 64 bytes
    ]);
    // 6. Broadcast
    const broadcastResult = await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'broadcast',
        method: 'broadcast_tx_commit',
        params: [signedTx.toString('base64')],
    });
    if (broadcastResult?.status?.Failure) {
        throw new Error(`Contract execution failed: ${JSON.stringify(broadcastResult.status.Failure)}`);
    }
    log('info', 'kv_store_committed', { key, txHash: broadcastResult?.transaction?.hash });
}
// ──────────────────────────
// Auth0 JWT Verification
// ──────────────────────────
// Get signing key from Auth0
function getKey(header, callback) {
    JWKS_CLIENT.getSigningKey(header.kid, (err, key) => {
        callback(err || null, key?.getPublicKey());
    });
}
// Verify Auth0 JWT
async function verifyAuth0Token(token) {
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
                payload[`https://${AUTH0_AUDIENCE}/email`];
            const sub = payload.sub ||
                payload[`https://${AUTH0_AUDIENCE}/sub`];
            if (!email || !sub)
                return reject(new Error('Missing claims'));
            resolve({ email, sub });
        });
    });
}
// ────────────────────────────────────────────────
// API Key Helpers (deterministic now)
// ────────────────────────────────────────────────
function generateApiKey() {
    const randomBytes = crypto.randomBytes(32);
    let encoded = '';
    for (let i = 0; i < randomBytes.length; i++) {
        encoded += BASE62_CHARSET[randomBytes[i] % 62];
    }
    return `nova_sk_${encoded}`;
}
function hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
}
// ────────────────────────────────────────────────
// Attestation
// ────────────────────────────────────────────────
// TODO: replace stub with real Nitro enclave attestation once deployed.
// Production path:
//   1. Read PCR0/PCR1/PCR2 from /dev/nsm via vsock or NSM API
//   2. Fetch expected hashes stored in KV contract under key 'expected-pcrs'
//   3. Compare and throw if mismatch — block all key ops until attestation passes
async function getAttestation() {
    const provider = process.env.ENCLAVE_PROVIDER || 'local';
    if (provider === 'nitro') {
        // Real Nitro path (uncomment when NSM device is available):
        // const nsm = await import('@aws-nitro-enclaves/nsm-api');
        // const doc = await nsm.getAttestationDoc();
        // const pcr0 = doc.pcrs[0].toString('hex');
        // const expected = await getBlobFromKV('expected-pcrs');
        // if (!expected || !verifyPcrs(doc.pcrs, expected)) throw new Error('Attestation mismatch');
        // return { provider: 'nitro', pcr0, verified: true };
        throw new Error('Nitro NSM not yet wired — set ENCLAVE_PROVIDER=local for dev');
    }
    // Stub for local / pre-Nitro development
    const devPcr0 = process.env.DEV_PCR0 || '0'.repeat(96); // 48-byte PCR0 as hex
    return { provider: 'local', pcr0: devPcr0, verified: false };
}
// ────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
function checkRateLimit(key) {
    const now = Date.now();
    const entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    if (entry.count >= RATE_LIMIT_MAX)
        return false;
    entry.count++;
    return true;
}
const userKeys = new Hono();
// Ensure master seed is loaded before any route handler runs
userKeys.use('*', async (c, next) => {
    await initializeMasterSeedIfNeeded();
    await next();
});
// STORE - Store user key (deterministic derivation)
userKeys.post('/store', async (c) => {
    const clientIp = c.req.header('x-forwarded-for') ?? 'unknown';
    if (!checkRateLimit(clientIp)) {
        return c.json({ error: 'Rate limit exceeded — max 10 store requests per minute' }, 429);
    }
    try {
        const { email, account_id, private_key, public_key, network, auth_token, wallet_id } = await c.req.json();
        if (!email || !account_id || !private_key || !public_key || !network) {
            return c.json({ error: 'Missing required fields' }, 400);
        }
        let verifiedUser = null;
        if (auth_token) {
            verifiedUser = await verifyAuth0Token(auth_token);
            if (verifiedUser.email !== email)
                return c.json({ error: 'Email mismatch' }, 403);
        }
        else if (wallet_id) {
            verifiedUser = { email, sub: `wallet|${wallet_id}` };
        }
        else {
            return c.json({ error: 'auth_token or wallet_id required' }, 400);
        }
        if (!private_key.startsWith('ed25519:'))
            return c.json({ error: 'Invalid private key format' }, 400);
        if (!['testnet', 'mainnet'].includes(network))
            return c.json({ error: 'Invalid network' }, 400);
        // Deterministic salt for this user
        const salt = `user:${verifiedUser.sub}:${account_id}`;
        const derivedWrapper = deriveKey(salt); // 32-byte wrapper key
        // Encrypt the actual private key with derived wrapper
        const encryptedPrivateKey = encryptBlob(Buffer.from(private_key, 'utf8'));
        // Store encrypted blob on KV
        const keyId = crypto.createHash('sha256').update(salt).digest('hex');
        await storeBlobToKV(keyId, encryptedPrivateKey);
        const checksum = 'derived-' + crypto.createHash('sha256').update(derivedWrapper).digest('hex').slice(0, 16);
        return c.json({
            success: true,
            account_id,
            network,
            wallet_id: wallet_id || null,
            checksum,
            key_id: keyId,
        });
    }
    catch (error) {
        console.error('Store error:', error);
        return c.json({ error: 'Failed to store key', details: error.message }, 500);
    }
});
// RETRIEVE - Fetch and decrypt
userKeys.post('/retrieve', async (c) => {
    try {
        const { email, auth_token, account_id, wallet_id: walletId } = await c.req.json();
        let verifiedUser = null;
        let targetAccountId;
        if (account_id) {
            targetAccountId = account_id;
        }
        else if (email && auth_token) {
            verifiedUser = await verifyAuth0Token(auth_token);
            if (verifiedUser.email !== email)
                return c.json({ error: 'Unauthorized' }, 403);
            targetAccountId = account_id || 'derived';
        }
        else {
            return c.json({ error: 'Missing fields' }, 400);
        }
        // Reconstruct the exact same salt used in /store
        // wallet_id path: sub = 'wallet|{wallet_id}'
        // auth_token path: sub = verifiedUser.sub
        const sub = verifiedUser?.sub || (walletId ? `wallet|${walletId}` : null);
        if (!sub)
            return c.json({ error: 'Cannot derive key id without auth_token or wallet_id' }, 400);
        const keyId = crypto.createHash('sha256').update(`user:${sub}:${targetAccountId}`).digest('hex');
        const encryptedBlob = await getBlobFromKV(keyId);
        if (!encryptedBlob)
            return c.json({ error: 'Account not found' }, 404);
        const privateKey = Buffer.from(decryptBlob(encryptedBlob)).toString('utf8');
        const checksum = 'derived-verified';
        return c.json({
            account_id: targetAccountId,
            private_key: privateKey,
            public_key: 'derived-from-seed',
            network: 'mainnet',
            wallet_id: null,
            checksum,
        });
    }
    catch (error) {
        console.error('Retrieve error:', error);
        return c.json({ error: 'Failed to retrieve key', details: error.message }, 500);
    }
});
// Existence check via KV
userKeys.post('/check', async (c) => {
    try {
        const { email, auth_token, wallet_id, account_id } = await c.req.json();
        let targetAccountId;
        let verifiedSub;
        if (account_id && !auth_token && !wallet_id) {
            targetAccountId = account_id;
        }
        else if (email && auth_token) {
            const verified = await verifyAuth0Token(auth_token);
            if (verified.email !== email)
                return c.json({ error: 'Unauthorized' }, 403);
            verifiedSub = verified.sub;
            targetAccountId = account_id || 'unknown';
        }
        else if (wallet_id) {
            targetAccountId = account_id || 'wallet-derived';
        }
        else {
            return c.json({ error: 'Missing fields' }, 400);
        }
        const sub = verifiedSub
            ? verifiedSub
            : wallet_id
                ? `wallet|${wallet_id}`
                : email || 'unknown';
        const salt = `user:${sub}:${targetAccountId}`;
        const keyId = crypto.createHash('sha256').update(salt).digest('hex');
        const blob = await getBlobFromKV(keyId);
        const exists = !!blob;
        return c.json({
            exists,
            account_id: targetAccountId,
            // minimal info - no sensitive data
        });
    }
    catch (error) {
        console.error('Check error:', error);
        return c.json({ error: 'Check failed', details: error.message }, 500);
    }
});
// GENERATE API KEY - Deterministic salt-based
userKeys.post('/generate-api-key', async (c) => {
    try {
        const { email, auth_token, account_id } = await c.req.json();
        let targetAccountId;
        if (account_id) {
            targetAccountId = account_id;
        }
        else if (email && auth_token) {
            const verified = await verifyAuth0Token(auth_token);
            if (verified.email !== email)
                return c.json({ error: 'Unauthorized' }, 403);
            targetAccountId = account_id || 'unknown';
        }
        else {
            return c.json({ error: 'Missing fields' }, 400);
        }
        // Derive deterministic API key from master seed + salt
        const salt = `api-key:${targetAccountId}`;
        const apiKeyBytes = deriveKey(salt, 32);
        const apiKey = `nova_sk_${Buffer.from(apiKeyBytes).toString('base64url').slice(0, 43)}`;
        const apiKeyHash = hashApiKey(apiKey);
        // Store hash on KV under derived key
        const hashKeyId = crypto.createHash('sha256').update(`api-hash:${targetAccountId}`).digest('hex');
        await storeBlobToKV(hashKeyId, encryptBlob(Buffer.from(apiKeyHash, 'utf8')));
        return c.json({
            success: true,
            api_key: apiKey,
            account_id: targetAccountId,
            message: 'Save this key securely — it will not be shown again.',
        });
    }
    catch (error) {
        console.error('Generate API key error:', error);
        return c.json({ error: 'Generation failed', details: error.message }, 500);
    }
});
// VERIFY API KEY - Compare hash from KV
userKeys.post('/verify-api-key', async (c) => {
    try {
        const { api_key, account_id } = await c.req.json();
        if (!api_key || !account_id)
            return c.json({ error: 'Missing fields' }, 400);
        if (!api_key.startsWith('nova_sk_') || api_key.length < 40)
            return c.json({ valid: false, error: 'Invalid format' }, 401);
        const providedHash = hashApiKey(api_key);
        const hashKeyId = crypto.createHash('sha256').update(`api-hash:${account_id}`).digest('hex');
        const storedHash = await getBlobFromKV(hashKeyId);
        if (!storedHash)
            return c.json({ valid: false, error: 'No API key configured' }, 401);
        const storedHashStr = Buffer.from(decryptBlob(storedHash)).toString('utf8');
        const isValid = crypto.timingSafeEqual(Buffer.from(storedHashStr, 'hex'), Buffer.from(providedHash, 'hex'));
        return c.json({
            valid: isValid,
            account_id,
            network: 'mainnet', // or detect
        });
    }
    catch (error) {
        console.error('Verify API key error:', error);
        return c.json({ valid: false, error: 'Verification failed', details: error.message }, 500);
    }
});
// HAS-API-KEY - Check if hash blob exists
userKeys.post('/has-api-key', async (c) => {
    try {
        const { email, auth_token, account_id } = await c.req.json();
        let targetAccountId;
        if (account_id) {
            targetAccountId = account_id;
        }
        else if (email && auth_token) {
            const verified = await verifyAuth0Token(auth_token);
            if (verified.email !== email)
                return c.json({ error: 'Unauthorized' }, 403);
            targetAccountId = account_id || 'unknown';
        }
        else {
            return c.json({ error: 'Missing fields' }, 400);
        }
        const hashKeyId = crypto.createHash('sha256').update(`api-hash:${targetAccountId}`).digest('hex');
        const hashBlob = await getBlobFromKV(hashKeyId);
        return c.json({
            has_api_key: !!hashBlob,
            account_id: targetAccountId,
        });
    }
    catch (error) {
        console.error('Has API key error:', error);
        return c.json({ error: 'Check failed', details: error.message }, 500);
    }
});
// Health check - Init master seed + show status
userKeys.get('/', async (c) => {
    try {
        // Ensure master seed is loaded/initialized
        await initializeMasterSeedIfNeeded();
        const attestation = await getAttestation();
        return c.json({
            status: 'healthy',
            service: 'user-account-keys',
            attestation: attestation.provider,
            attestation_pcr0: attestation.pcr0,
            attestation_verified: attestation.verified,
            auth: 'Auth0 JWT verified (idToken or accessToken)',
            master_seed_status: 'initialized',
        });
    }
    catch (error) {
        return c.json({ error: 'Health check failed', details: error.message }, 500);
    }
});
void generateApiKey;
export default userKeys;

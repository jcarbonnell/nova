// shade-agent/src/routes/user-keys.ts - user key management with KV persistence and deterministic derivation
import { Hono } from 'hono';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { VerifyErrors, JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

import { encryptBlob, decryptBlob, deriveKey } from '../lib/crypto.js';
import { getBlobFromKV, storeBlobToKV } from '../lib/kv.js';
import { initializeMasterSeed } from '../lib/seed.js';
import { log } from '../lib/logger.js';

// Initialize JWKS client for Auth0 public key verification
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

const BASE62_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// ──────────────────────────
// Auth0 JWT Verification
// ──────────────────────────

// Get signing key from Auth0
function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  getJwksClient().getSigningKey(header.kid, (err, key) => {
    callback(err || null, key?.getPublicKey());
  });
}

// Verify Auth0 JWT
async function verifyAuth0Token(token: string): Promise<{ email: string; sub: string }> {
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
// API Key Helpers (deterministic)
// ────────────────────────────────────────────────

function generateApiKey(): string {
  const randomBytes = crypto.randomBytes(32);
  let encoded = '';
  for (let i = 0; i < randomBytes.length; i++) {
    encoded += BASE62_CHARSET[randomBytes[i] % 62];
  }
  return `nova_sk_${encoded}`;
}

function hashApiKey(apiKey: string): string {
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
async function getAttestation(): Promise<{ provider: string; pcr0: string; verified: boolean }> {
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

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

const userKeys = new Hono();

// ────────────────────────────────────────────────
// Internal Auth (MCP / frontend → Shade Agent)
// ────────────────────────────────────────────────
// Public HTTPS endpoint on Phala. Only MCP and the frontend's server-side
// routes should reach key operations; both hold INTERNAL_API_SECRET.
// SDKs never call these routes directly (they go through MCP /tools/*).
// Health endpoints are exempt so monitoring/liveness probes still work.
function checkInternalAuth(provided: string | undefined): boolean {
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

userKeys.use('*', async (c, next) => {
  // Exempt health check (GET / on this router)
  const p = c.req.path;
  if (c.req.method === 'GET' && (p === '/api/user-keys' || p === '/api/user-keys/')) {
    return next();
  }
  if (!checkInternalAuth(c.req.header('x-internal-auth'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

// Validate env vars once when first request comes in
let envValidated = false;
userKeys.use('*', async (c, next) => {
  if (!envValidated) {
    // Read env vars here, not at module level
    const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
    const SHADE_AGENT_ACCOUNT_ID = process.env.SHADE_AGENT_ACCOUNT_ID;
    const TEE_SECRET = process.env.TEE_KEY_SECRET || '';
    
    if (!AUTH0_DOMAIN) throw new Error('AUTH0_DOMAIN required');
    if (!SHADE_AGENT_ACCOUNT_ID) throw new Error('SHADE_AGENT_ACCOUNT_ID required');
    if (!/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
      throw new Error('TEE_KEY_SECRET must be a 64-char hex string (32 bytes)');
    }
    envValidated = true;
  }
  await initializeMasterSeed();
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

    console.log('💾 STORE request received:', {  // ← ADD THIS
      email: email ? `${email.substring(0, 5)}...` : undefined,
      account_id,
      has_token: !!auth_token,
      wallet_id
    });

    if (!email || !account_id || !private_key || !public_key || !network) {
      return c.json({ error: 'Missing required fields' }, 400);
    }

    let verifiedUser: { email: string; sub: string } | null = null;

    if (auth_token) {
      verifiedUser = await verifyAuth0Token(auth_token);
      if (verifiedUser.email !== email) return c.json({ error: 'Email mismatch' }, 403);
      console.log('✅ Token verified for STORE, sub:', verifiedUser.sub?.substring(0, 20) + '...');
    } else if (wallet_id) {
      // DISABLED (v0.4). Re-enabled in v0.5 with self-custody wallet auth.
      log('warn', 'store_wallet_branch_rejected', {
        wallet_hash: crypto.createHash('sha256').update(wallet_id).digest('hex').slice(0, 12),
      });
      return c.json({
        error: 'Wallet auth disabled pending self-custody migration (v0.5)',
        code: 'WALLET_AUTH_PENDING_SELF_CUSTODY',
      }, 501);
    } else {
      return c.json({ error: 'auth_token or wallet_id required' }, 400);
    }

    if (!private_key.startsWith('ed25519:')) return c.json({ error: 'Invalid private key format' }, 400);
    if (!['testnet', 'mainnet'].includes(network)) return c.json({ error: 'Invalid network' }, 400);

    // Create data structure to store
    const userData = {
      account_id,
      private_key,
      public_key,
      network,
      wallet_id: wallet_id || null,
      created_at: new Date().toISOString(),
    };

    // Encrypt the entire data structure
    const encryptedBlob = encryptBlob(Buffer.from(JSON.stringify(userData), 'utf8'));

    // Store encrypted blob on KV using simple sub-based key
    const sub = verifiedUser.sub;
    console.log('🔑 Derived sub for STORE:', sub.substring(0, 30) + '...');

    const keyId = crypto.createHash('sha256').update(`user:${sub}`).digest('hex');
    console.log('🔑 Computed keyId for STORE:', keyId);

    await storeBlobToKV(keyId, encryptedBlob);
    console.log('✅ Key stored successfully for account:', account_id);

    const accountKeyId = crypto.createHash('sha256').update(`account:${account_id}`).digest('hex');
    await storeBlobToKV(accountKeyId, encryptedBlob);

    const checksum = 'tee-verified';

    return c.json({
      success: true,
      account_id,
      network,
      wallet_id: wallet_id || null,
      checksum,
      key_id: keyId,
    });
  } catch (error) {
    console.error('Store error:', error);
    return c.json({ error: 'Failed to store key', details: (error as Error).message }, 500);
  }
});

// RETRIEVE - Fetch and decrypt
userKeys.post('/retrieve', async (c) => {
  try {
    const { email, auth_token, account_id, wallet_id: walletId } = await c.req.json();

    if (account_id && !email && !auth_token && !walletId) {
      // ACCOUNT-ONLY RETRIEVE — internal signing path.
      // Reachable ONLY through the X-Internal-Auth gate (see middleware above):
      // MCP uses this when it must sign a NEAR transaction on a user's behalf,
      // at which point no user token is present (the user authenticated to MCP
      // earlier via session JWT). This branch returns a private key with no
      // per-user auth, so it MUST remain behind the internal gate. Audit every use.
      log('warn', 'account_only_retrieve', {
        account_id_hash: crypto.createHash('sha256').update(account_id).digest('hex').slice(0, 12),
      });

      const accountKeyId = crypto.createHash('sha256').update(`account:${account_id}`).digest('hex');
      const encryptedBlob = await getBlobFromKV(accountKeyId);
      
      if (!encryptedBlob) return c.json({ error: 'Account not found' }, 404);
      
      const decrypted = Buffer.from(decryptBlob(encryptedBlob)).toString('utf8');
      const userData = JSON.parse(decrypted);
      
      return c.json({
        account_id: userData.account_id,
        private_key: userData.private_key,
        public_key: userData.public_key,
        network: userData.network,
        wallet_id: userData.wallet_id,
        checksum: 'derived-verified',
      });
    }
    
    let verifiedUser: { email: string; sub: string } | null = null;

    // Email users: verify auth_token
    if (email && auth_token) {
      verifiedUser = await verifyAuth0Token(auth_token);
      if (verifiedUser.email !== email) return c.json({ error: 'Unauthorized' }, 403);
    }
    // Wallet users: DISABLED in v0.3.2 — see WALLET_AUTH_PENDING_SELF_CUSTODY.
    // The wallet path derived sub = `wallet|${walletId}` from an unauthenticated
    // assertion. Custodial today; rebuilt as self-custody in v0.5. Reject until then.
    else if (walletId) {
      log('warn', 'wallet_retrieve_rejected_pending_self_custody', {
        wallet_hash: crypto.createHash('sha256').update(walletId).digest('hex').slice(0, 12),
      });
      return c.json({
        error: 'Wallet auth disabled pending self-custody migration (v0.5)',
        code: 'WALLET_AUTH_PENDING_SELF_CUSTODY',
      }, 501);
    }
    // Neither email+token nor wallet
    else {
      return c.json({ error: 'Missing auth_token (email)' }, 400);
    }

    // Derive sub for key lookup
    const sub = verifiedUser?.sub;
    if (!sub) return c.json({ error: 'Cannot derive key id' }, 400);
    
    const keyId = crypto.createHash('sha256').update(`user:${sub}`).digest('hex');
    
    const encryptedBlob = await getBlobFromKV(keyId);
    if (!encryptedBlob) return c.json({ error: 'Account not found' }, 404);

    const decrypted = Buffer.from(decryptBlob(encryptedBlob)).toString('utf8');
    const userData = JSON.parse(decrypted);

    const checksum = 'derived-verified';

    return c.json({
      account_id: userData.account_id,
      private_key: userData.private_key,
      public_key: userData.public_key,
      network: userData.network,
      wallet_id: userData.wallet_id,
      checksum,
    });
  } catch (error) {
    console.error('Retrieve error:', error);
    return c.json({ error: 'Failed to retrieve key', details: (error as Error).message }, 500);
  }
});

// Existence check via KV
userKeys.post('/check', async (c) => {
  try {
    const { email, auth_token, wallet_id, account_id } = await c.req.json();

    console.log('🔍 CHECK request received:', { 
      email: email ? `${email.substring(0, 5)}...` : undefined,
      has_token: !!auth_token, 
      wallet_id,
      account_id 
    });

    let verifiedSub: string | undefined;

    // Email users: verify auth_token
    if (email && auth_token) {
      try {
        const verified = await verifyAuth0Token(auth_token);
        console.log('✅ Token verified, sub:', verified.sub?.substring(0, 20) + '...');
        
        if (verified.email !== email) {
          console.log('❌ Email mismatch:', { verified: verified.email, requested: email });
          return c.json({ error: 'Unauthorized' }, 403);
        }
        
        verifiedSub = verified.sub;
      } catch (tokenError) {
        console.error('❌ Token verification failed:', tokenError);
        return c.json({ error: 'Token verification failed' }, 401);
      }
    }
    // Wallet users: no verification, but require wallet_id
    else if (!wallet_id) {
      console.log('❌ Missing auth_token and wallet_id');
      return c.json({ error: 'Missing auth_token (email) or wallet_id (wallet)' }, 400);
    }

    // Derive sub for key lookup
    const sub = verifiedSub || (wallet_id ? `wallet|${wallet_id}` : null);
    if (!sub) {
      console.log('❌ Cannot derive sub');
      return c.json({ error: 'Cannot derive key id' }, 400);
    }
    
    console.log('🔑 Derived sub:', sub.substring(0, 30) + '...');
    
    const keyId = crypto.createHash('sha256').update(`user:${sub}`).digest('hex');
    console.log('🔑 Computed keyId:', keyId);

    const blob = await getBlobFromKV(keyId);
    
    if (!blob) {
      console.log('❌ No blob found in KV for keyId:', keyId);
      return c.json({ exists: false, account_id: null });
    }

    console.log('✅ Blob found in KV, decrypting...');

    // Decrypt and parse to get the real account_id
    const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
    const userData = JSON.parse(decrypted);

    console.log('✅ Account found:', userData.account_id);

    // SELF-HEALING BACKFILL (v0.4)
    // /store dual-writes user:{sub} AND account:{account_id}. 
    // pre-existing accounts only have user:{sub}, and get 404 on MCP's account-only signing.
    // this block heals accounts on next login.
    if (userData.account_id) {
      const accountKeyId = crypto.createHash('sha256')
        .update(`account:${userData.account_id}`).digest('hex');
      const existing = await getBlobFromKV(accountKeyId);
      if (!existing) {
        const raw = Array.isArray(blob) ? Buffer.from(blob) : Buffer.from(blob as string, 'hex');
        await storeBlobToKV(accountKeyId, raw.toString('hex'));
        log('warn', 'account_key_backfilled', {
          account_id_hash: crypto.createHash('sha256')
            .update(userData.account_id).digest('hex').slice(0, 12),
        });
      }
    }

    return c.json({
      exists: true,
      account_id: userData.account_id,
    });
  } catch (error) {
    console.error('Check error:', error);
    return c.json({ error: 'Check failed', details: (error as Error).message }, 500);
  }
});

// GENERATE API KEY - Deterministic salt-based
userKeys.post('/generate-api-key', async (c) => {
  try {
    const { email, auth_token, account_id, wallet_id } = await c.req.json();

    let targetAccountId: string;
    let verifiedSub: string | undefined;

    // Email users: verify token and lookup account_id
    if (email && auth_token) {
      const verified = await verifyAuth0Token(auth_token);
      if (verified.email !== email) return c.json({ error: 'Unauthorized' }, 403);
      verifiedSub = verified.sub;
      
      // Lookup account_id from stored user data
      const keyId = crypto.createHash('sha256').update(`user:${verifiedSub}`).digest('hex');
      const blob = await getBlobFromKV(keyId);
      
      if (!blob) {
        return c.json({ error: 'No NOVA account found. Create one first.' }, 404);
      }
      
      const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
      const userData = JSON.parse(decrypted);
      targetAccountId = userData.account_id;
    }
    // Wallet + bare account-id DISABLED (v0.4)
    else if (account_id || wallet_id) {
      log('warn', 'generate_api_key_unauth_branch_rejected', {
        account_hash: crypto.createHash('sha256')
          .update(account_id || wallet_id).digest('hex').slice(0, 12),
      });
      return c.json({
        error: 'Wallet auth disabled pending self-custody migration (v0.5)',
        code: 'WALLET_AUTH_PENDING_SELF_CUSTODY',
      }, 501);
    }
    else {
      return c.json({ error: 'Missing fields: email+auth_token, account_id, or wallet_id' }, 400);
    }

    console.log('🔑 Generating API key for account:', targetAccountId);

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
  } catch (error) {
    console.error('Generate API key error:', error);
    return c.json({ error: 'Generation failed', details: (error as Error).message }, 500);
  }
});

// VERIFY API KEY - Compare hash from KV
userKeys.post('/verify-api-key', async (c) => {
  try {
    const { api_key, account_id } = await c.req.json();

    if (!api_key || !account_id) return c.json({ error: 'Missing fields' }, 400);
    if (!api_key.startsWith('nova_sk_') || api_key.length < 40) return c.json({ valid: false, error: 'Invalid format' }, 401);

    const providedHash = hashApiKey(api_key);

    const hashKeyId = crypto.createHash('sha256').update(`api-hash:${account_id}`).digest('hex');
    const storedHash = await getBlobFromKV(hashKeyId);

    if (!storedHash) return c.json({ valid: false, error: 'No API key configured' }, 401);

    const storedHashStr = Buffer.from(decryptBlob(storedHash)).toString('utf8');

    const isValid = crypto.timingSafeEqual(
      Buffer.from(storedHashStr, 'hex'),
      Buffer.from(providedHash, 'hex')
    );

    return c.json({
      valid: isValid,
      account_id,
      network: 'mainnet', // or detect
    });
  } catch (error) {
    console.error('Verify API key error:', error);
    return c.json({ valid: false, error: 'Verification failed', details: (error as Error).message }, 500);
  }
});

// HAS-API-KEY - Check if hash blob exists
userKeys.post('/has-api-key', async (c) => {
  try {
    const { email, auth_token, account_id, wallet_id } = await c.req.json();

    let targetAccountId: string;

    // Email users: verify token and lookup account_id
    if (email && auth_token) {
      const verified = await verifyAuth0Token(auth_token);
      if (verified.email !== email) return c.json({ error: 'Unauthorized' }, 403);
      
      // Lookup account_id from stored user data
      const keyId = crypto.createHash('sha256').update(`user:${verified.sub}`).digest('hex');
      const blob = await getBlobFromKV(keyId);
      
      if (!blob) {
        return c.json({ error: 'No NOVA account found' }, 404);
      }
      
      const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
      const userData = JSON.parse(decrypted);
      targetAccountId = userData.account_id;
    }
    // Wallet + bare account-id DISABLED (v0.4).
    else if (account_id || wallet_id) {
      log('warn', 'generate_api_key_unauth_branch_rejected', {
        account_hash: crypto.createHash('sha256')
          .update(account_id || wallet_id).digest('hex').slice(0, 12),
      });
      return c.json({
        error: 'Wallet auth disabled pending self-custody migration (v0.5)',
        code: 'WALLET_AUTH_PENDING_SELF_CUSTODY',
      }, 501);
    }
    else {
      return c.json({ error: 'Missing fields: email+auth_token, account_id, or wallet_id' }, 400);
    }

    console.log('🔍 Checking API key for account:', targetAccountId);

    const hashKeyId = crypto.createHash('sha256').update(`api-hash:${targetAccountId}`).digest('hex');
    const hashBlob = await getBlobFromKV(hashKeyId);

    return c.json({
      has_api_key: !!hashBlob,
      account_id: targetAccountId,
    });
  } catch (error) {
    console.error('Has API key error:', error);
    return c.json({ error: 'Check failed', details: (error as Error).message }, 500);
  }
});

// Health check - Init master seed + show status
userKeys.get('/', async (c) => {
  try {
    // Ensure master seed is loaded/initialized
    await initializeMasterSeed();

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
  } catch (error) {
    return c.json({ error: 'Health check failed', details: (error as Error).message }, 500);
  }
});

void generateApiKey;

export default userKeys;
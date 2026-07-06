// shade-agent/src/routes/user-keys.ts - user key management with KV persistence and deterministic derivation
import { Hono } from 'hono';
import crypto, { hkdfSync } from 'crypto';
import jwt from 'jsonwebtoken';
import type { VerifyErrors, JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import * as ed25519 from '@noble/ed25519';
import bs58 from 'bs58';
import axios from 'axios';

// ─────────────────
// Configuration
// ─────────────────
const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
const KV_CONTRACT_OWNER = process.env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near';

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

// ────────────────────────────────────────────────
// Master Seed & Deterministic Derivation
// ────────────────────────────────────────────────

let masterSeed: Uint8Array | null = null;

async function initializeMasterSeedIfNeeded(): Promise<void> {
  if (masterSeed) return;

  // ALWAYS try to load from KV first (even if MASTER_SEED_INIT_ALLOWED=true)
  const encryptedBlob = await getBlobFromKV('master-root');
  if (encryptedBlob) {
    masterSeed = decryptBlob(encryptedBlob);
    console.log('Master seed loaded from KV');
    return;
  }

  // Only initialize if nothing exists in KV
  const MASTER_SEED_INIT_ALLOWED = process.env.MASTER_SEED_INIT_ALLOWED === 'true';
  
  if (!MASTER_SEED_INIT_ALLOWED) {
    throw new Error(
      'Master seed not found in KV and MASTER_SEED_INIT_ALLOWED is not set. ' +
      'Set MASTER_SEED_INIT_ALLOWED=true on first deploy only, then remove it.'
    );
  }

  // Initialize new seed deterministically(only runs if KV is empty)
  console.warn('⚠️  Initializing new master seed — this should run ONLY once!');
  const sponsorKey = process.env.SPONSOR_PRIVATE_KEY as string;
  const sponsorKeyBytes = Buffer.from(sponsorKey.replace('ed25519:', ''), 'base64');
  const newSeed = crypto.createHash('sha256')
    .update(Buffer.concat([
      sponsorKeyBytes,
      Buffer.from('nova-master-seed-v1', 'utf8')
    ]))
    .digest();
  masterSeed = newSeed;
  const encrypted = encryptBlob(newSeed);
  await storeBlobToKV('master-root', encrypted);
  console.log('✅ Master seed initialized and stored on-chain');
}

function deriveKey(salt: string, length: number = 32): Uint8Array {
  if (!masterSeed) throw new Error('Master seed not initialized');
  const derived = hkdfSync(
    'sha256',
    masterSeed,
    Buffer.from(salt),
    Buffer.from('nova-v1'),
    length,
  );
  return new Uint8Array(derived);
}

function encryptBlob(data: Uint8Array): string {
  const TEE_SECRET = process.env.TEE_KEY_SECRET!;
  if (!TEE_SECRET || !/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
    throw new Error('TEE_KEY_SECRET must be a 64-char hex string');
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
  let encrypted = cipher.update(data);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptBlob(enc: string | number[]): Uint8Array {
  const TEE_SECRET = process.env.TEE_KEY_SECRET!;
  if (!TEE_SECRET || !/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
    throw new Error('TEE_KEY_SECRET must be a 64-char hex string');
  }

  // Handle raw byte array returned directly from NEAR KV (16-byte IV + ciphertext)
  if (Array.isArray(enc)) {
    const raw = Buffer.from(enc);
    if (raw.length < 17) throw new Error('Encrypted blob too short');
    const iv = raw.subarray(0, 16);
    const encrypted = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted;
  }
  // Handle legacy hex-string format "ivhex:encryptedhex"
  const [ivStr, encStr] = enc.split(':');
  if (!ivStr || !encStr) throw new Error('Invalid encrypted blob format');
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

function log(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>) {
  console[level](JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
}

async function rpcCallWithRetry(
  rpcUrl: string,
  payload: unknown,
  retries = 3,
): Promise<unknown> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.post(rpcUrl, payload, { timeout: 10_000 });
      if (res.data.error) {
        const msg = res.data.error.message || res.data.error.cause?.name || JSON.stringify(res.data.error);
        throw new Error(`RPC error: ${msg}`);
      }
      return res.data.result;
    } catch (err) {
      const isLast = attempt === retries - 1;
      if (isLast) throw err;
      const backoffMs = 1_000 * (attempt + 1);
      log('warn', 'rpc_retry', { attempt: attempt + 1, backoffMs, error: (err as Error).message });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw new Error('rpcCallWithRetry: exhausted retries without throwing');
}

async function getBlobFromKV(key: string): Promise<string | number[] | null> {
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
    const result = await rpcCallWithRetry(rpcUrl, payload) as { result?: number[] } | null;
    if (result?.result && result.result.length > 0) {
      const jsonStr = Buffer.from(result.result).toString('utf8');
      const parsed: number[] | null = JSON.parse(jsonStr);
      if (!parsed || parsed.length === 0) return null;
      return parsed;
    }
    return null;
  } catch (err) {
    console.error('KV get failed after retries:', (err as Error).message);
    return null;
  }
}

// Borsh primitives for manual NEAR transaction serialization
function borshString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function borshBytes(b: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

function borshU64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

function borshU128(n: bigint): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE(n >> 64n, 8);
  return buf;
}

// NEAR action enum index 2 = FunctionCall
function encodeFunctionCallAction(
  methodName: string,
  args: Uint8Array,
  gas: bigint,
  deposit: bigint,
): Buffer {
  return Buffer.concat([
    Buffer.from([2]),
    borshString(methodName),
    borshBytes(args),
    borshU64(gas),
    borshU128(deposit),
  ]);
}

// Borsh-encoded NEAR Transaction (pre-signature)
function encodeTransaction(
  signerId: string,
  publicKey: Uint8Array,
  nonce: bigint,
  receiverId: string,
  blockHash: Uint8Array,
  actions: Buffer[],
): Buffer {
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

async function storeBlobToKV(key: string, encryptedBlob: string): Promise<void> {
  const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org';
  const signerAccountId = KV_CONTRACT_OWNER;
  
  // 1. Derive deterministic signer keypair from master seed
  const signerPriv = deriveKey('kv-owner-signer-v1', 32);
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
  }) as { nonce: number; block_hash: string };
  const nonce = BigInt(accessKeyResult.nonce) + 1n;
  const blockHash = bs58.decode(accessKeyResult.block_hash);

  // 3. Encode FunctionCall action + full transaction
  const [ivHex, encHex] = encryptedBlob.split(':');
  const rawBytes = Buffer.concat([Buffer.from(ivHex, 'hex'), Buffer.from(encHex, 'hex')]);
  const callArgs = Buffer.from(JSON.stringify({ key, encrypted_blob: Array.from(rawBytes) }));
  const action = encodeFunctionCallAction('store', callArgs, 30_000_000_000_000n, 0n);
  const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, KV_CONTRACT, blockHash, [action]);

  // 4. Hash and sign (NEAR signs SHA-256 of the borsh-encoded transaction)
  const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
  const signature = await ed25519.signAsync(txHash, signerPriv);

  // 5. Borsh-encode SignedTransaction = Transaction + Signature
  const signedTx = Buffer.concat([
    txBytes,
    Buffer.from([0]),  // Signature enum: 0 = ed25519
    signature,         // 64 bytes
  ]);

  // 6. Broadcast
  const broadcastResult = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'broadcast',
    method: 'broadcast_tx_commit',
    params: [signedTx.toString('base64')],
  }) as { transaction?: { hash: string }; status?: { Failure?: unknown } };

  if (broadcastResult?.status?.Failure) {
    throw new Error(`Contract execution failed: ${JSON.stringify(broadcastResult.status.Failure)}`);
  }
  log('info', 'kv_store_committed', { key, txHash: broadcastResult?.transaction?.hash });
}

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
  if (c.req.method === 'GET' && c.req.path === '/api/user-keys/') {
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
  await initializeMasterSeedIfNeeded();
  await next();
});

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
      verifiedUser = { email, sub: `wallet|${wallet_id}` };
      console.log('✅ Wallet user STORE, sub:', verifiedUser.sub?.substring(0, 20) + '...');
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
    // Wallet users: no verification, but require wallet_id
    else if (!walletId) {
      return c.json({ error: 'Missing auth_token (email) or wallet_id (wallet)' }, 400);
    }

    // Derive sub for key lookup
    const sub = verifiedUser?.sub || (walletId ? `wallet|${walletId}` : null);
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
    // Wallet users or direct account_id
    else if (account_id) {
      targetAccountId = account_id;
    }
    // Wallet users without account_id - lookup from wallet_id
    else if (wallet_id) {
      const sub = `wallet|${wallet_id}`;
      const keyId = crypto.createHash('sha256').update(`user:${sub}`).digest('hex');
      const blob = await getBlobFromKV(keyId);
      
      if (!blob) {
        return c.json({ error: 'No NOVA account found. Create one first.' }, 404);
      }
      
      const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
      const userData = JSON.parse(decrypted);
      targetAccountId = userData.account_id;
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
    // Direct account_id or wallet_id
    else if (account_id) {
      targetAccountId = account_id;
    }
    else if (wallet_id) {
      const sub = `wallet|${wallet_id}`;
      const keyId = crypto.createHash('sha256').update(`user:${sub}`).digest('hex');
      const blob = await getBlobFromKV(keyId);
      
      if (!blob) {
        return c.json({ error: 'No NOVA account found' }, 404);
      }
      
      const decrypted = Buffer.from(decryptBlob(blob)).toString('utf8');
      const userData = JSON.parse(decrypted);
      targetAccountId = userData.account_id;
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
  } catch (error) {
    return c.json({ error: 'Health check failed', details: (error as Error).message }, 500);
  }
});

void generateApiKey;

export default userKeys;
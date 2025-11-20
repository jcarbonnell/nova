// routes/user-keys.ts
import { Hono } from 'hono';
import { agentInfo } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Initialize JWKS client for Auth0 public key verification
const client = jwksClient({
  jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
});

// Get signing key from Auth0
function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

// ✅ SECURE: Verify Auth0 JWT with cryptographic signature
async function verifyAuth0Token(token: string): Promise<{ email: string; sub: string }> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        audience: process.env.AUTH0_AUDIENCE || 'https://nova-mcp.fastmcp.app',
        issuer: `https://${process.env.AUTH0_DOMAIN}/`,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) {
          console.error('JWT verification failed:', err.message);
          reject(new Error('Invalid token'));
          return;
        }

        const payload = decoded as jwt.JwtPayload;
        
        if (!payload.email || !payload.sub) {
          reject(new Error('Token missing required claims'));
          return;
        }

        resolve({
          email: payload.email,
          sub: payload.sub,
        });
      }
    );
  });
}

// Database setup
const userKeysDb = new Database('./nova-user-keys.db');
userKeysDb.exec(`
  CREATE TABLE IF NOT EXISTS user_account_keys (
    user_email TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    account_id TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    public_key TEXT NOT NULL,
    network TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_sub ON user_account_keys(user_sub);
`);

const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.AUTH0_DOMAIN) {
  throw new Error('AUTH0_DOMAIN environment variable required');
}

// Encryption helpers (unchanged)
function encryptKey(key: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
  let encrypted = cipher.update(key);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptKey(enc: string): string {
  const [ivStr, encStr] = enc.split(':');
  if (!ivStr || !encStr) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(ivStr, 'hex');
  const encrypted = Buffer.from(encStr, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(TEE_SECRET, 'hex'), iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

const userKeys = new Hono();

// ========== STORE ENDPOINT (SECURE) ==========
userKeys.post('/store', async (c) => {
  try {
    const { email, account_id, private_key, public_key, network, auth_token } = await c.req.json();
    
    if (!email || !account_id || !private_key || !public_key || !network || !auth_token) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    
    // ✅ CRITICAL: Verify Auth0 JWT token cryptographically
    let verifiedUser;
    try {
      verifiedUser = await verifyAuth0Token(auth_token);
    } catch (err) {
      console.error('❌ Token verification failed:', err);
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }
    
    // ✅ CRITICAL: Email in JWT must match request email
    if (verifiedUser.email !== email) {
      console.error('❌ Email mismatch:', { tokenEmail: verifiedUser.email, requestEmail: email });
      return c.json({ error: 'Email mismatch - unauthorized' }, 403);
    }
    
    // Validate private key
    if (!private_key.startsWith('ed25519:')) {
      return c.json({ error: 'Invalid private key format' }, 400);
    }
    
    if (!['testnet', 'mainnet'].includes(network)) {
      return c.json({ error: 'Invalid network' }, 400);
    }
    
    // Encrypt and store
    const encryptedPrivateKey = encryptKey(private_key);
    const now = new Date().toISOString();
    
    userKeysDb.prepare(`
      INSERT OR REPLACE INTO user_account_keys 
      (user_email, user_sub, account_id, encrypted_private_key, public_key, network, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(email, verifiedUser.sub, account_id, encryptedPrivateKey, public_key, network, now, now);
    
    const info = await agentInfo();
    
    console.log(`✅ Stored key for verified user: ${verifiedUser.sub} → ${account_id}`);
    
    return c.json({ 
      success: true, 
      account_id,
      network,
      checksum: info.checksum,
    });
  } catch (error) {
    console.error('❌ Store error:', error);
    return c.json({ 
      error: 'Failed to store key',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// ========== RETRIEVE ENDPOINT (SECURE) ==========
userKeys.post('/retrieve', async (c) => {
  try {
    const { email, auth_token } = await c.req.json();
    
    if (!email || !auth_token) {
      return c.json({ error: 'Missing email or auth_token' }, 400);
    }
    
    // ✅ CRITICAL: Verify Auth0 JWT
    let verifiedUser;
    try {
      verifiedUser = await verifyAuth0Token(auth_token);
    } catch (err) {
      console.error('❌ Token verification failed:', err);
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }
    
    // ✅ CRITICAL: Email must match
    if (verifiedUser.email !== email) {
      console.error('❌ Email mismatch:', { tokenEmail: verifiedUser.email, requestEmail: email });
      return c.json({ error: 'Unauthorized' }, 403);
    }
    
    // Query by Auth0 user ID (sub) for extra security
    const row = userKeysDb.prepare(`
      SELECT account_id, encrypted_private_key, public_key, network 
      FROM user_account_keys 
      WHERE user_sub = ? AND user_email = ?
    `).get(verifiedUser.sub, email) as {
      account_id: string;
      encrypted_private_key: string;
      public_key: string;
      network: string;
    } | undefined;
    
    if (!row) {
      return c.json({ error: 'Account not found' }, 404);
    }
    
    // Decrypt in TEE
    const privateKey = decryptKey(row.encrypted_private_key);
    const info = await agentInfo();
    
    console.log(`✅ Retrieved key for verified user: ${verifiedUser.sub} → ${row.account_id}`);
    
    return c.json({
      account_id: row.account_id,
      private_key: privateKey,
      public_key: row.public_key,
      network: row.network,
      checksum: info.checksum
    });
  } catch (error) {
    console.error('❌ Retrieve error:', error);
    return c.json({ 
      error: 'Failed to retrieve key',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// ========== CHECK ENDPOINT (SECURE) ==========
userKeys.post('/check', async (c) => {
  try {
    const { email, auth_token } = await c.req.json();
    
    if (!email || !auth_token) {
      return c.json({ error: 'Missing email or auth_token' }, 400);
    }
    
    // ✅ CRITICAL: Verify Auth0 JWT
    let verifiedUser;
    try {
      verifiedUser = await verifyAuth0Token(auth_token);
    } catch (err) {
      console.error('❌ Token verification failed:', err);
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }
    
    // ✅ CRITICAL: Email must match
    if (verifiedUser.email !== email) {
      console.error('❌ Email mismatch:', { tokenEmail: verifiedUser.email, requestEmail: email });
      return c.json({ error: 'Unauthorized' }, 403);
    }
    
    const row = userKeysDb.prepare(`
      SELECT account_id, public_key, network, created_at 
      FROM user_account_keys 
      WHERE user_sub = ? AND user_email = ?
    `).get(verifiedUser.sub, email) as {
      account_id: string;
      public_key: string;
      network: string;
      created_at: string;
    } | undefined;
    
    if (!row) {
      return c.json({ exists: false });
    }
    
    console.log(`✅ Account found for verified user: ${verifiedUser.sub}`);
    
    return c.json({
      exists: true,
      account_id: row.account_id,
      public_key: row.public_key,
      network: row.network,
      created_at: row.created_at
    });
  } catch (error) {
    console.error('❌ Check error:', error);
    return c.json({ 
      error: 'Failed to check account',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Health check
userKeys.get('/', async (c) => {
  try {
    const info = await agentInfo();
    const count = userKeysDb.prepare('SELECT COUNT(*) as count FROM user_account_keys').get() as { count: number };
    
    return c.json({
      status: 'healthy',
      service: 'user-account-keys',
      stored_accounts: count.count,
      checksum: info.checksum,
      auth: 'Auth0 JWT RS256 verified'
    });
  } catch (error) {
    return c.json({ error: 'Health check failed' }, 500);
  }
});

export default userKeys;
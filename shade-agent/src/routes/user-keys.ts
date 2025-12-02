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

// ✅ SECURE: Verify Auth0 JWT - SIMPLIFIED VERSION
async function verifyAuth0Token(token: string): Promise<{ email: string; sub: string }> {
  return new Promise((resolve, reject) => {
    // First decode to check audience
    const decoded: any = jwt.decode(token, { complete: true });
    
    if (!decoded || !decoded.payload) {
      reject(new Error('Invalid token format'));
      return;
    }
    
    // Get all possible valid audiences
    const validAudiences = [
      process.env.AUTH0_AUDIENCE || 'https://nova-mcp.fastmcp.app',
      process.env.AUTH0_CLIENT_ID,
    ].filter((a): a is string => !!a) as [string, ...string[]];
    
    console.log('Verifying token with audiences:', validAudiences);
    
    jwt.verify(
      token,
      getKey,
      {
        audience: validAudiences,
        issuer: `https://${process.env.AUTH0_DOMAIN}/`,
        algorithms: ['RS256'],
      },
      (err: any, verified: any) => {
        if (err) {
          console.error('JWT verification failed:', err.message);
          reject(new Error('Invalid token'));
          return;
        }

        const payload = verified as any;
        
        // Extract email and sub - check multiple possible locations
        const email = payload.email || payload['https://nova-mcp.fastmcp.app/email'];
        const sub = payload.sub || payload['https://nova-mcp.fastmcp.app/sub'];
        
        if (!email || !sub) {
          console.error('Missing claims:', Object.keys(payload));
          reject(new Error('Token missing required claims'));
          return;
        }

        console.log('✅ Token verified:', email.substring(0, 10) + '...');
        resolve({ email, sub });
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
    wallet_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_user_sub ON user_account_keys(user_sub);
  CREATE INDEX IF NOT EXISTS idx_account_id ON user_account_keys(account_id);
  CREATE INDEX IF NOT EXISTS idx_wallet_id ON user_account_keys(wallet_id);
`);

const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.AUTH0_DOMAIN) {
  throw new Error('AUTH0_DOMAIN environment variable required');
}

// Log config
console.log('Shade TEE Config:', {
  AUTH0_DOMAIN: process.env.AUTH0_DOMAIN,
  AUTH0_CLIENT_ID: process.env.AUTH0_CLIENT_ID ? 'Set' : 'Missing',
  AUTH0_AUDIENCE: process.env.AUTH0_AUDIENCE || 'https://nova-mcp.fastmcp.app',
});

// Encryption helpers
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

// ========== STORE ENDPOINT ==========
userKeys.post('/store', async (c) => {
  try {
    const { email, account_id, private_key, public_key, network, auth_token, wallet_id } = await c.req.json();
    
    // wallet_id is optional, auth_token is optional for wallet users
    if (!email || !account_id || !private_key || !public_key || !network) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    
    let verifiedUser: { email: string; sub: string } | null = null;
    
    // If auth_token provided, verify it (email users)
    if (auth_token) {
      try {
        verifiedUser = await verifyAuth0Token(auth_token);
        if (verifiedUser.email !== email) {
          console.error('Email mismatch');
          return c.json({ error: 'Email mismatch' }, 403);
        }
      } catch (err) {
        console.error('Token verification failed:', err);
        return c.json({ error: 'Invalid or expired authentication token' }, 401);
      }
    } else if (wallet_id) {
      // no Auth0 token for wallet users, use wallet_id as identifier
      verifiedUser = {
        email: email,
        sub: `wallet|${wallet_id}`,
      };
      console.log('Storing key for wallet user:', wallet_id);
    } else {
      return c.json({ error: 'Either auth_token or wallet_id required' }, 400);
    }
    
    if (!private_key.startsWith('ed25519:')) {
      return c.json({ error: 'Invalid private key format' }, 400);
    }
    
    if (!['testnet', 'mainnet'].includes(network)) {
      return c.json({ error: 'Invalid network' }, 400);
    }
    
    const encryptedPrivateKey = encryptKey(private_key);
    const now = new Date().toISOString();
    
    userKeysDb.prepare(`
      INSERT OR REPLACE INTO user_account_keys 
      (user_email, user_sub, account_id, encrypted_private_key, public_key, network, wallet_id, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(email, verifiedUser.sub, account_id, encryptedPrivateKey, public_key, network, wallet_id || null, now, now);
    
    const info = await agentInfo();
    
    console.log('Stored key for:', verifiedUser.sub, wallet_id ? `(wallet: ${wallet_id})` : '');
    
    return c.json({ 
      success: true, 
      account_id,
      network,
      wallet_id: wallet_id || null,
      checksum: info.checksum,
    });
  } catch (error) {
    console.error('Store error:', error);
    return c.json({ 
      error: 'Failed to store key',
      details: error instanceof Error ? error.message : 'Unknown'
    }, 500);
  }
});

// ========== RETRIEVE ENDPOINT ==========
userKeys.post('/retrieve', async (c) => {
  try {
    const { email, auth_token, account_id } = await c.req.json();
    
    // Wallet users: Retrieve by account_id
    if (account_id) {
      const row = userKeysDb.prepare(`
        SELECT account_id, encrypted_private_key, public_key, network, wallet_id
        FROM user_account_keys 
        WHERE account_id = ?
      `).get(account_id) as any;
      
      if (!row) {
        return c.json({ error: 'Account not found' }, 404);
      }
      
      const privateKey = decryptKey(row.encrypted_private_key);
      const info = await agentInfo();
      
      console.log('Retrieved key by account_id:', account_id);
      
      return c.json({
        account_id: row.account_id,
        private_key: privateKey,
        public_key: row.public_key,
        network: row.network,
        wallet_id: row.wallet_id,
        checksum: info.checksum
      });
    }
    
    // Email users: Retrieve by email + auth_token
    if (!email || !auth_token) {
      return c.json({ error: 'Missing email or auth_token' }, 400);
    }
    
    let verifiedUser;
    try {
      verifiedUser = await verifyAuth0Token(auth_token);
    } catch (err) {
      console.error('Token verification failed:', err);
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }
    
    if (verifiedUser.email !== email) {
      console.error('Email mismatch');
      return c.json({ error: 'Unauthorized' }, 403);
    }
    
    const row = userKeysDb.prepare(`
      SELECT account_id, encrypted_private_key, public_key, network, wallet_id 
      FROM user_account_keys 
      WHERE user_sub = ? AND user_email = ?
    `).get(verifiedUser.sub, email) as any;
    
    if (!row) {
      return c.json({ error: 'Account not found' }, 404);
    }
    
    const privateKey = decryptKey(row.encrypted_private_key);
    const info = await agentInfo();
    
    console.log('Retrieved key for:', verifiedUser.sub);
    
    return c.json({
      account_id: row.account_id,
      private_key: privateKey,
      public_key: row.public_key,
      network: row.network,
      wallet_id: row.wallet_id,
      checksum: info.checksum
    });
  } catch (error) {
    console.error('Retrieve error:', error);
    return c.json({ 
      error: 'Failed to retrieve key',
      details: error instanceof Error ? error.message : 'Unknown'
    }, 500);
  }
});

// ========== CHECK ENDPOINT ==========
userKeys.post('/check', async (c) => {
  try {
    const { email, auth_token, wallet_id, account_id } = await c.req.json();
    
    // Wallet users: Check by wallet_id
    if (wallet_id) {
      const row = userKeysDb.prepare(`
        SELECT account_id, public_key, network, created_at 
        FROM user_account_keys 
        WHERE wallet_id = ?
      `).get(wallet_id) as any;
      
      if (!row) {
        return c.json({ exists: false, wallet_id });
      }
      
      console.log('Account found for wallet:', wallet_id);
      
      return c.json({
        exists: true,
        account_id: row.account_id,
        public_key: row.public_key,
        network: row.network,
        wallet_id: wallet_id,
        created_at: row.created_at
      });
    }
    
    // Email users: Check by email + auth_token
    if (!email || !auth_token) {
      return c.json({ error: 'Missing email or auth_token or wallet_id' }, 400);
    }
    
    let verifiedUser;
    try {
      verifiedUser = await verifyAuth0Token(auth_token);
    } catch (err) {
      console.error('Token verification failed:', err);
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }
    
    if (verifiedUser.email !== email) {
      console.error('Email mismatch');
      return c.json({ error: 'Unauthorized' }, 403);
    }
    
    const row = userKeysDb.prepare(`
      SELECT account_id, public_key, network, wallet_id, created_at 
      FROM user_account_keys 
      WHERE user_sub = ? AND user_email = ?
    `).get(verifiedUser.sub, email) as any;
    
    if (!row) {
      return c.json({ exists: false });
    }
    
    console.log('Account found for:', verifiedUser.sub);
    
    return c.json({
      exists: true,
      account_id: row.account_id,
      public_key: row.public_key,
      network: row.network,
      wallet_id: row.wallet_id,
      created_at: row.created_at
    });
  } catch (error) {
    console.error('Check error:', error);
    return c.json({ 
      error: 'Failed to check account',
      details: error instanceof Error ? error.message : 'Unknown'
    }, 500);
  }
});

// Health check
userKeys.get('/', async (c) => {
  try {
    const info = await agentInfo();
    const count = userKeysDb.prepare('SELECT COUNT(*) as count FROM user_account_keys').get() as any;
    
    return c.json({
      status: 'healthy',
      service: 'user-account-keys',
      stored_accounts: count.count,
      checksum: info.checksum,
      auth: 'Auth0 JWT verified (idToken or accessToken)'
    });
  } catch (error) {
    return c.json({ error: 'Health check failed' }, 500);
  }
});

export default userKeys;
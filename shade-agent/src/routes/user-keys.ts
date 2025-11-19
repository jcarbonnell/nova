// routes/user-keys.ts
import { Hono } from 'hono';
import { agentInfo } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// Separate database for user keys (isolation)
const userKeysDb = new Database('./nova-user-keys.db');
userKeysDb.exec(`
  CREATE TABLE IF NOT EXISTS user_account_keys (
    user_email TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    encrypted_private_key TEXT NOT NULL,
    public_key TEXT NOT NULL,
    network TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// TEE-derived secret (same as key-management for consistency)
const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');

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

// Simple auth verification (in production, verify Auth0 JWT)
function verifyAuthToken(authToken: string, email: string): boolean {
  // TODO: Implement proper JWT verification with Auth0
  // For now, basic validation
  if (!authToken || authToken.length < 10) {
    return false;
  }
  // Decode base64 token and check email matches (simple implementation)
  try {
    const decoded = Buffer.from(authToken, 'base64').toString('utf-8');
    return decoded.includes(email);
  } catch {
    return false;
  }
}

const userKeys = new Hono();

// Store user account key (called after NEAR account creation)
userKeys.post('/store', async (c) => {
  try {
    const { email, account_id, private_key, public_key, network, auth_token } = await c.req.json();
    
    if (!email || !account_id || !private_key || !public_key || !network) {
      return c.json({ error: 'Missing required fields: email, account_id, private_key, public_key, network' }, 400);
    }
    
    // Verify auth token
    if (!auth_token || !verifyAuthToken(auth_token, email)) {
      return c.json({ error: 'Invalid authentication' }, 401);
    }
    
    // Validate private key format
    if (!private_key.startsWith('ed25519:')) {
      return c.json({ error: 'Invalid private key format (must start with ed25519:)' }, 400);
    }
    
    // Validate network
    if (!['testnet', 'mainnet'].includes(network)) {
      return c.json({ error: 'Invalid network (must be testnet or mainnet)' }, 400);
    }
    
    // Encrypt and store
    const encryptedPrivateKey = encryptKey(private_key);
    const createdAt = new Date().toISOString();
    
    userKeysDb.prepare(`
      INSERT OR REPLACE INTO user_account_keys 
      (user_email, account_id, encrypted_private_key, public_key, network, created_at) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(email, account_id, encryptedPrivateKey, public_key, network, createdAt);
    
    // Get TEE attestation
    const info = await agentInfo();
    
    console.log(`✅ Stored account key for ${email} -> ${account_id} (${network})`);
    
    return c.json({ 
      success: true, 
      account_id,
      network,
      checksum: info.checksum,
      message: 'Private key securely stored in TEE'
    });
  } catch (error) {
    console.error('❌ Failed to store user key:', error);
    return c.json({ 
      error: 'Failed to store key',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Retrieve user account key (for signing transactions)
userKeys.post('/retrieve', async (c) => {
  try {
    const { email, auth_token } = await c.req.json();
    
    if (!email || !auth_token) {
      return c.json({ error: 'Missing required fields: email, auth_token' }, 400);
    }
    
    // Verify auth token
    if (!verifyAuthToken(auth_token, email)) {
      return c.json({ error: 'Invalid authentication' }, 401);
    }
    
    const row = userKeysDb.prepare(`
      SELECT account_id, encrypted_private_key, public_key, network 
      FROM user_account_keys 
      WHERE user_email = ?
    `).get(email) as {
      account_id: string;
      encrypted_private_key: string;
      public_key: string;
      network: string;
    } | undefined;
    
    if (!row) {
      return c.json({ error: 'Account key not found for this email' }, 404);
    }
    
    // Decrypt private key in TEE
    const privateKey = decryptKey(row.encrypted_private_key);
    
    // Get TEE attestation
    const info = await agentInfo();
    
    console.log(`✅ Retrieved account key for ${email} -> ${row.account_id}`);
    
    return c.json({
      account_id: row.account_id,
      private_key: privateKey,
      public_key: row.public_key,
      network: row.network,
      checksum: info.checksum
    });
  } catch (error) {
    console.error('❌ Failed to retrieve user key:', error);
    return c.json({ 
      error: 'Failed to retrieve key',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Check if user has account (public info only)
userKeys.post('/check', async (c) => {
  try {
    const { email, auth_token } = await c.req.json();
    
    if (!email || !auth_token) {
      return c.json({ error: 'Missing required fields: email, auth_token' }, 400);
    }
    
    // Verify auth token
    if (!verifyAuthToken(auth_token, email)) {
      return c.json({ error: 'Invalid authentication' }, 401);
    }
    
    const row = userKeysDb.prepare(`
      SELECT account_id, public_key, network, created_at 
      FROM user_account_keys 
      WHERE user_email = ?
    `).get(email) as {
      account_id: string;
      public_key: string;
      network: string;
      created_at: string;
    } | undefined;
    
    if (!row) {
      console.log(`No account found for ${email}`);
      return c.json({ exists: false });
    }
    
    console.log(`✅ Account found for ${email}: ${row.account_id}`);
    
    return c.json({
      exists: true,
      account_id: row.account_id,
      public_key: row.public_key,
      network: row.network,
      created_at: row.created_at
    });
  } catch (error) {
    console.error('❌ Failed to check user account:', error);
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
      tee_secure: true
    });
  } catch (error) {
    console.error('Health check error:', error);
    return c.json({ error: 'Health check failed' }, 500);
  }
});

export default userKeys;
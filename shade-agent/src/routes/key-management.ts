// Shade agent manages keys for NOVA groups in a TEE-secure manner
import { Hono } from 'hono';
import { agentInfo, agentView } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Persistent encrypted DB (TEE-secure; use file for persistence across restarts)
const db = new Database('./nova-keys.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    group_id TEXT PRIMARY KEY,
    encrypted_key TEXT
  );
`);

// TEE-derived secret (in prod, derive from TEE entropy; here simulate)
const TEE_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// NOVA contract ID from env
const NOVA_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk-2.testnet';

// Helpers
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

function verifyToken(token: string): { valid: boolean; user_id?: string; group_id?: string } {
  try {
    const decoded = jwt.verify(token, TEE_SECRET) as jwt.JwtPayload;
    if (decoded.exp && Date.now() >= decoded.exp * 1000) {
      return { valid: false };
    }
    return { 
      valid: true, 
      user_id: decoded.user_id as string, 
      group_id: decoded.group_id as string 
    };
  } catch {
    return { valid: false };
  }
}

const keyMgmt = new Hono();

// Generate key for a group (called by NOVA contract after group registration)
keyMgmt.post('/generate_key', async (c) => {
  const { group_id, owner } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Verify group exists on-chain
  const groupExists = await agentView({
    contractId: NOVA_CONTRACT,
    methodName: 'group_contains_key',
    args: { group_id }
  });
  if (!groupExists) return c.json({ error: 'Group does not exist on-chain' }, 404);
  
  // Derive key in TEE (random 32 bytes)
  const keyBytes = crypto.randomBytes(32);
  const key = keyBytes.toString('base64');
  
  // Encrypt and store (idempotent)
  const encryptedKey = encryptKey(key);
  db.prepare('INSERT OR REPLACE INTO keys (group_id, encrypted_key) VALUES (?, ?)').run(group_id, encryptedKey);
  
  // Attest via agentInfo
  const info = await agentInfo();
  if (!info.checksum) {
    return c.json({ error: 'Attestation failed' }, 500);
  }
  
  console.log(`Generated key for group ${group_id}, owner ${owner}`);
  
  return c.json({ key, checksum: info.checksum });
});

// Get key for authorized user (requires JWT token)
keyMgmt.post('/get_key', async (c) => {
  const { group_id, token } = await c.req.json();
  if (!group_id || !token) return c.json({ error: 'group_id and token required' }, 400);
  
  const tokenInfo = verifyToken(token);
  if (!tokenInfo.valid || !tokenInfo.user_id) {
    return c.json({ error: 'Invalid token' }, 403);
  }
  
  const user_id = tokenInfo.user_id;
  
  // Verify on-chain authorization (this is the key security check)
  const authorized = await agentView({
    contractId: NOVA_CONTRACT,
    methodName: 'is_authorized',
    args: { group_id, user_id }
  });
  if (!authorized) return c.json({ error: 'Unauthorized: On-chain access denied' }, 403);

  // Fetch key from DB
  const row = db.prepare('SELECT encrypted_key FROM keys WHERE group_id = ?').get(group_id) as { encrypted_key: string } | undefined;
  if (!row || !row.encrypted_key) {
    return c.json({ error: 'Key not found' }, 404);
  }
  
  const key = decryptKey(row.encrypted_key);
  
  // Attest
  const info = await agentInfo();
  
  console.log(`Retrieved key for group ${group_id}, user ${user_id}`);
  
  return c.json({ key, checksum: info.checksum });
});

// Rotate key (called by NOVA contract when member is revoked)
keyMgmt.post('/rotate_key', async (c) => {
  const { group_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Verify group exists
  const groupExists = await agentView({
    contractId: NOVA_CONTRACT,
    methodName: 'group_contains_key',
    args: { group_id }
  });
  if (!groupExists) return c.json({ error: 'Group does not exist' }, 404);

  // Generate new key, encrypt, update DB (atomic)
  const newKey = crypto.randomBytes(32).toString('base64');  
  const encryptedKey = encryptKey(newKey);
  const result = db.prepare('UPDATE keys SET encrypted_key = ? WHERE group_id = ?').run(encryptedKey, group_id);
  
  if (result.changes === 0) {
    return c.json({ error: 'Key not found for rotation' }, 404);
  }
  
  // Attest
  const info = await agentInfo();

  console.log(`Rotated key for group ${group_id}`);

  return c.json({ 
    success: true, 
    new_key_hash: crypto.createHash('sha256').update(newKey).digest('hex'), 
    checksum: info.checksum 
  });
});

export default keyMgmt;
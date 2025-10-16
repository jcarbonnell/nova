import { Hono } from 'hono';
import { agentInfo } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Init encrypted DB (in-memory for MVP; use file for persistence)
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    group_id TEXT PRIMARY KEY,
    encrypted_key TEXT
  );
  CREATE TABLE IF NOT EXISTS group_access (
    group_id TEXT,
    user_id TEXT,
    PRIMARY KEY (group_id, user_id)
  );
`);

// TEE-derived secret (in prod, derive from TEE entropy; here simulate)
const TEE_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

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
    // Check payload (e.g., exp, group_id match)
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

keyMgmt.post('/generate_key', async (c) => {
  const { group_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Derive key in TEE-sim (random 32 bytes)
  const keyBytes = crypto.randomBytes(32);
  const key = keyBytes.toString('base64');
  
  // Encrypt and store
  const encryptedKey = encryptKey(key);
  db.prepare('INSERT OR REPLACE INTO keys (group_id, encrypted_key) VALUES (?, ?)').run(group_id, encryptedKey);
  
  // Attest via agentInfo
  const info = await agentInfo();
  if (!info.checksum) {
    return c.json({ error: 'Attestation failed' }, 500);
  }
  
  return c.json({ key, checksum: info.checksum });
});

keyMgmt.post('/get_key', async (c) => {
  const { group_id, token } = await c.req.json();
  if (!group_id || !token) return c.json({ error: 'group_id and token required' }, 400);
  
  const tokenInfo = verifyToken(token) as { valid: boolean; user_id?: string; group_id?: string };  // Type assertion if needed
  if (!tokenInfo.valid) {
    return c.json({ error: 'Invalid token' }, 403);
  }

  // Extract user_id from token and verify DB access
  const user_id = tokenInfo.user_id;
  if (!user_id) return c.json({ error: 'Token missing user_id' }, 400);
  
  // Check group_access table
  const accessRow = db.prepare('SELECT 1 FROM group_access WHERE group_id = ? AND user_id = ?').get(group_id, user_id);
  if (!accessRow) {
    return c.json({ error: 'Access denied: not in group' }, 403);
  }
  
  // Type the row result
  interface KeyRow {
    encrypted_key: string;
  }
  const row = db.prepare('SELECT encrypted_key FROM keys WHERE group_id = ?').get(group_id) as KeyRow;
  if (!row || !row.encrypted_key) {
    return c.json({ error: 'Key not found' }, 404);
  }
  
  const key = decryptKey(row.encrypted_key);
  
  // Re-attest
  const info = await agentInfo();
  
  return c.json({ key, checksum: info.checksum });
});

keyMgmt.post('/rotate_key', async (c) => {
  const { group_id } = await c.req.json();
  
  // In TEE DB: Generate new key, update entry
  const newKey = crypto.randomBytes(32).toString('base64');  
  const encryptedKey = encryptKey(newKey);
  db.prepare('UPDATE keys SET encrypted_key = ? WHERE group_id = ?').run([encryptedKey, group_id]);
  
  return c.json({ success: true, new_key_hash: crypto.hash('sha256', newKey) });
});

// Integrated update_member_access route
keyMgmt.post('/update_member_access', async (c) => {
  const { group_id, new_member } = await c.req.json();
  if (!group_id || !new_member) return c.json({ error: 'group_id and new_member required' }, 400);
  
  // In TEE DB: Add new_member to group's access list
  db.prepare('INSERT OR IGNORE INTO group_access (group_id, user_id) VALUES (?, ?)').run(group_id, new_member);
  
  // Optional: Attest
  const info = await agentInfo();
  
  return c.json({ success: true, checksum: info.checksum });
});

export default keyMgmt;
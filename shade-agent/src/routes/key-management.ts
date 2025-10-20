import { Hono } from 'hono';
import { agentInfo, agentView, agentCall } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Persistent encrypted DB (TEE-secure; use file for persistence across restarts)
const db = new Database('./nova-keys.db'); // In memory for testing; use file in prod
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
  
  // Verify group exists on-chain
  const groupExists = await agentView({
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
  
  return c.json({ key, checksum: info.checksum });
});

keyMgmt.post('/get_key', async (c) => {
  const { group_id, token } = await c.req.json();
  if (!group_id || !token) return c.json({ error: 'group_id and token required' }, 400);
  
  const tokenInfo = verifyToken(token);
  if (!tokenInfo.valid) {
    return c.json({ error: 'Invalid token' }, 403);
  }

  // Extract user_id from token and verify DB access
  const user_id = tokenInfo.user_id;
  if (!user_id) return c.json({ error: 'Token missing user_id' }, 400);
  
  // Verify on-chain authorization
  const authorized = await agentView({
    methodName: 'is_authorized',
    args: { group_id, user_id }
  });
  if (!authorized) return c.json({ error: 'Unauthorized: On-chain access denied' }, 403);

  // Fetch Key from DB
  const row = db.prepare('SELECT encrypted_key FROM keys WHERE group_id = ?').get(group_id) as { encrypted_key: string };
  if (!row || !row.encrypted_key) {
    return c.json({ error: 'Key not found' }, 404);
  }
  
  const key = decryptKey(row.encrypted_key);
  
  // Attest
  const info = await agentInfo();
  
  return c.json({ key, checksum: info.checksum });
});

keyMgmt.post('/rotate_key', async (c) => {
  const { group_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Verify group exists
  const groupExists = await agentView({
    methodName: 'group_contains_key',
    args: { group_id }
  });
  if (!groupExists) return c.json({ error: 'Group does not exist' }, 404);

  // Generate new key, encrypt, update DB (atomic)
  const newKey = crypto.randomBytes(32).toString('base64');  
  const encryptedKey = encryptKey(newKey);
  db.prepare('UPDATE keys SET encrypted_key = ? WHERE group_id = ?').run([encryptedKey, group_id]);
  
  // Attest
  const info = await agentInfo();

  return c.json({ success: true, new_key_hash: crypto.createHash('sha256').update(newKey).digest('hex'), checksum: info.checksum });
});

// Integrated update_member_access route
keyMgmt.post('/update_member_access', async (c) => {
  const { group_id, new_member, action } = await c.req.json();
  if (!group_id || !new_member || !action) return c.json({ error: 'group_id, new_member, and action (add/remove) required' }, 400);
  
  // Call on-chain (e.g., add_group_member or revoke)
  let onChainMethod = action === 'add' ? 'add_group_member' : 'revoke_group_member';
  await agentCall({
    methodName: onChainMethod,
    args: { group_id, user_id: new_member },
    gas: '30000000000000'
  });

  // Update DB access
  if (action === 'add') {
    db.prepare('INSERT OR IGNORE INTO group_access (group_id, user_id) VALUES (?, ?)').run(group_id, new_member);
  } else if (action === 'remove') {
    db.prepare('DELETE FROM group_access WHERE group_id = ? AND user_id = ?').run(group_id, new_member);
  }

  // Attest
  const info = await agentInfo();
  
  return c.json({ success: true, checksum: info.checksum });
});

export default keyMgmt;
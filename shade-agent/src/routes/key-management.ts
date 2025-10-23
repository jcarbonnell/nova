// Shade agent manages keys for NOVA groups in a TEE-secure manner
import { Hono } from 'hono';
import { agentInfo, agentCall, agentView } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import { verify } from '@noble/ed25519';

// Persistent encrypted DB (TEE-secure; use file for persistence across restarts)
const db = new Database('./nova-keys.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS keys (
    group_id TEXT PRIMARY KEY,
    encrypted_key TEXT
  );
`);

// TEE-derived secret (in prod, derive from TEE entropy; here simulate)
const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');

// NOVA contract ID from env
const NOVA_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk-4.testnet';

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

async function verifyToken(token: string): Promise<{ valid: boolean; user_id?: string; group_id?: string; nonce?: string; timestamp?: number; public_key?: string }> {
  try {
    const [payloadB64, sigHex] = token.split('.');
    if (!payloadB64 || !sigHex) {
      return { valid: false };
    }
    
    // Decode payload to bytes (raw for ed25519 verify)
    const payload_bytes = Buffer.from(payloadB64, 'base64');
    if (payload_bytes.length === 0) {
      return { valid: false };
    }
    
    // Decode to str for JSON (for fields extraction)
    const payloadStr = payload_bytes.toString('utf-8');
    const payload = JSON.parse(payloadStr);
    
    const { group_id, user_id, nonce, timestamp, public_key } = payload;  // Added public_key
    if (!group_id || !user_id || !nonce || !timestamp || !public_key) {  // Require PK
      return { valid: false };
    }
    
    // Check timestamp freshness (e.g., < 5min old)
    const now = Date.now();
    if (timestamp > now + 300000 || timestamp < now - 300000) {  // 5min window
      return { valid: false };
    }
    
    // Verify nonce via contract view (prevents replay)
    const nonceValid = await agentView({
      methodName: 'get_nonce_validity',
      args: { group_id, user_id, nonce }
    });
    if (!nonceValid) {
      return { valid: false };
    }
    
    // Use payload public_key (ed25519:base58) for verify
    if (!public_key.startsWith('ed25519:')) {
      return { valid: false };
    }
    const userPkBytes = bs58.decode(public_key.slice(8));  // Decode base58 part to 32 bytes
    
    // Verify ed25519 on raw payload_bytes (no hash)
    const sigBytes = Buffer.from(sigHex, 'hex');
    const validSig = verify(sigBytes, payload_bytes, userPkBytes);
    if (!validSig) {
      return { valid: false };
    }
    
    return { 
      valid: true, 
      user_id, 
      group_id, 
      nonce, 
      timestamp,
      public_key  // Return for logging if needed
    };
  } catch (e) {
    console.error('Token verify error:', e);
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
  
  const tokenInfo = await verifyToken(token);
  if (!tokenInfo.valid || !tokenInfo.user_id) {
    return c.json({ error: 'Invalid token' }, 403);
  }
  
  const user_id = tokenInfo.user_id;
  const nonce = tokenInfo.nonce!;
  
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
  
  // Consume nonce on-chain (anti-replay)
  await agentCall({
    methodName: 'consume_nonce',  // Assume contract has this; or use claim_token's used_nonces
    args: { group_id, user_id, nonce },
    gas: '30000000000000n'
  });
  
  // Attest
  const info = await agentInfo();
  
  console.log(`Retrieved key for group ${group_id}, user ${user_id}`);
  
  return c.json({ key, checksum: info.checksum });
});

// Rotate key (called by NOVA contract when member is revoked)
keyMgmt.post('/rotate_key', async (c) => {
  const { group_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Verify caller is group owner (via contract view)
  const owner = await agentView({
    contractId: NOVA_CONTRACT,
    methodName: 'get_group_owner',  // Assume view exists; else fetch from state
    args: { group_id }
  });
  const caller = c.req.header('X-Caller') || 'unknown';  // Or from auth header; adjust
  if (caller !== owner) {
    return c.json({ error: 'Only group owner can rotate key' }, 403);
  }
  
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
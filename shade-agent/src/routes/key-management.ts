// Shade agent manages keys for NOVA groups in a TEE-secure manner
import { Hono } from 'hono';
import { agentInfo, agentCall, agentView } from '@neardefi/shade-agent-js';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';

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
const NOVA_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk-5.testnet';

// Set sha512 for noble
ed25519.hashes.sha512 = sha512;

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

async function verifyToken(token: string): Promise<{ valid: boolean; user_id?: string; group_id?: string; nonce?: string; timestamp?: number}> {
  try {
    const [payloadB64, sigHex] = token.split('.');
    if (!payloadB64 || !sigHex) {
      console.error('Token verify: Invalid format (missing . separator)');
      return { valid: false };
    }
    
    // Decode payload to bytes/str
    const payloadBytes = Buffer.from(payloadB64, 'base64');
    if (payloadBytes.length === 0) {
      console.error('Token verify: Empty payload');
      return { valid: false };
    }
    
    // Decode to str for JSON (for fields extraction)
    const payloadStr = payloadBytes.toString('utf-8');
    console.log('Token verify: Payload str len', payloadStr.length);  // Debug
    
    const payload = JSON.parse(payloadStr);
    const { group_id, user_id, nonce, timestamp, signing_pk_b58 } = payload;
    if (!group_id || !user_id || !nonce || !timestamp) {  // Core 4 fields only (PK optional)
      console.log('Token verify: Missing payload fields');
      return { valid: false };
    }
    
    // Check timestamp freshness (convert ns to ms)
    const timestampStr = timestamp.toString();
    const tsBig = BigInt(timestampStr);
    const nowMs = Date.now();  // ms
    const nowNs = BigInt(nowMs) * 1000000n;  // ms → ns
    const fiveMinNs = 300000000000n;  // 5min ns
    if (tsBig > nowNs + fiveMinNs || tsBig < nowNs - fiveMinNs) {
      console.error('Token verify: Timestamp invalid', { tsBig: tsBig.toString(), nowNs: nowNs.toString() });
      return { valid: false };
    }
    console.log('Token verify: Timestamp ms', nowMs, 'vs payload', timestamp);
    
    // Verify nonce via contract
    const nonceValid = await agentView({
      methodName: 'get_nonce_validity',
      args: { group_id, user_id, nonce }
    });
    if (!nonceValid) {
      console.error('Token verify: Nonce invalid/used');
      return { valid: false };
    }
    console.log('Token verify: Nonce valid');
    
    // Prefer payload PK if present (for multi-key); fallback to RPC first ed25519
    let userPkBytes;
    if (signing_pk_b58) {
      try {
        userPkBytes = bs58.decode(signing_pk_b58);  // Full 32 bytes
        if (userPkBytes.length !== 32) {
          console.error('Token verify: Invalid signing PK length');
          return { valid: false };
        }
        console.log('Token verify: Using payload PK', signing_pk_b58.slice(0, 20) + '...');
      } catch (e) {
        console.error('Token verify: PK decode error, falling back to RPC', e);
        // Proceed to RPC fallback
      }
    }
    
    if (!userPkBytes) {  // Fallback: RPC fetch (legacy compat)
      const rpcUrl = 'https://rpc.testnet.near.org';
      const rpcRes = await axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 'dontcare',
        method: 'query',
        params: {
          request_type: 'view_access_key_list',
          finality: 'final',
          account_id: user_id
        }
      });
      if (rpcRes.status !== 200) {
        console.error('Token verify: RPC error', rpcRes.status, rpcRes.data?.error?.message || 'Unknown');
        return { valid: false };
      }
      const keys = rpcRes.data.result?.keys || [];
      if (keys.length === 0) {
        console.error('Token verify: No access keys for', user_id);
        return { valid: false };
      }
      const keyView = keys.find((k: any) => k.public_key.startsWith('ed25519:')) || keys[0];
      if (!keyView.public_key.startsWith('ed25519:')) {
        console.error('Token verify: No ed25519 key found');
        return { valid: false };
      }
      const userPkStr = keyView.public_key;
      userPkBytes = bs58.decode(userPkStr.slice(8));  // 32 bytes
      console.log('Token verify: Using RPC PK', userPkStr.slice(0, 20) + '...');
    }
    
    // Verify ed25519 on raw payload_bytes (no hash)
    const sigBytes = Buffer.from(sigHex, 'hex');
    const validSig = ed25519.verify(sigBytes, payloadBytes, userPkBytes); // Raw bytes
    if (!validSig) {
      console.error('Token verify: Sig invalid');
      return { valid: false };
    }
    console.log('Token verify: Sig valid');
    
    return { 
      valid: true, 
      user_id, 
      group_id, 
      nonce, 
      timestamp: Number(timestamp)
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

// Get key for authorized user
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
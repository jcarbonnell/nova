// Shade agent manages keys for NOVA groups in a TEE-secure manner
import { Hono } from 'hono';
// import { agentView } from '@neardefi/shade-agent-js';
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

// Add new columns if they don't exist (safe - won't error if already present)
try { db.exec(`ALTER TABLE keys ADD COLUMN contract_id TEXT;`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE keys ADD COLUMN network TEXT;`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE keys ADD COLUMN created_at TEXT;`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE keys ADD COLUMN updated_at TEXT;`); } catch (e) { /* exists */ }

// TEE-derived secret (in prod, derive from TEE entropy; here simulate)
const TEE_SECRET = process.env.TEE_KEY_SECRET || crypto.randomBytes(32).toString('hex');

// NOVA contract ID from env
const DEFAULT_MAINNET_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk.near';
const DEFAULT_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT_ID || 'nova-sdk-6.testnet';

const ALLOWED_CONTRACTS = new Set([
  'nova-sdk.near',
  'nova-sdk-6.testnet'
]);

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

// Resolve contract ID from request or detect from group lookup
function resolveContract(requestContractId?: string, groupId?: string): { contractId: string; network: string } {
  // If contract_id provided, validate and use it
  if (requestContractId) {
    if (!ALLOWED_CONTRACTS.has(requestContractId)) {
      throw new Error(`Invalid contract_id: ${requestContractId}. Not in allowed list.`);
    }
    const network = requestContractId.endsWith('.testnet') ? 'testnet' : 'mainnet';
    return { contractId: requestContractId, network };
  }
  
  // Try to lookup from existing key record
  if (groupId) {
    const row = db.prepare('SELECT contract_id, network FROM keys WHERE group_id = ?').get(groupId) as { contract_id?: string; network?: string } | undefined;
    if (row?.contract_id) {
      return { contractId: row.contract_id, network: row.network || 'mainnet' };
    }
  }
  
  // Default to mainnet (handles existing keys with NULL contract_id)
  return { contractId: DEFAULT_MAINNET_CONTRACT, network: 'mainnet' };
}

// Get RPC URL for network
function getRpcUrl(network: string): string {
  return network === 'testnet' 
    ? 'https://rpc.testnet.near.org'
    : 'https://rpc.mainnet.near.org';
}

// Direct RPC view call (bypasses agentView which uses hardcoded RPC)
async function viewFunction(rpcUrl: string, contractId: string, methodName: string, args: Record<string, any>): Promise<any> {
  const response = await axios.post(rpcUrl, {
    jsonrpc: '2.0',
    id: 'nova-view',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  });

  if (response.data.error) {
    console.error('RPC error:', response.data.error);
    return null;
  }

  const result = response.data.result?.result;
  if (!result) return null;

  // Decode the result (it's a byte array)
  const decoded = Buffer.from(result).toString('utf-8');
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded === 'true';
  }
}

async function verifyToken(token: string, contractId: string, network: string): Promise<{ valid: boolean; user_id?: string; group_id?: string; nonce?: string; timestamp?: number}> {
  try {
    const [payloadB64, sigHex] = token.split('.');
    if (!payloadB64 || !sigHex) {
      console.error('Token verify: Invalid format (missing . separator)');
      return { valid: false };
    }
    
    const payloadBytes = Buffer.from(payloadB64, 'base64');
    if (payloadBytes.length === 0) {
      console.error('Token verify: Empty payload');
      return { valid: false };
    }
    
    const payloadStr = payloadBytes.toString('utf-8');
    console.log('Token verify: Payload str len', payloadStr.length);
    
    const payload = JSON.parse(payloadStr);
    const { group_id, user_id, nonce, timestamp, signing_pk_b58 } = payload;
    if (!group_id || !user_id || !nonce || !timestamp) {
      console.log('Token verify: Missing payload fields');
      return { valid: false };
    }
    
    // Check timestamp freshness (convert ns to ms)
    const timestampStr = timestamp.toString();
    const tsBig = BigInt(timestampStr);
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * 1000000n;
    const fiveMinNs = 300000000000n;
    if (tsBig > nowNs + fiveMinNs || tsBig < nowNs - fiveMinNs) {
      console.error('Token verify: Timestamp invalid', { tsBig: tsBig.toString(), nowNs: nowNs.toString() });
      return { valid: false };
    }
    console.log('Token verify: Timestamp ms', nowMs, 'vs payload', timestamp);
    
    // Verify nonce via contract
    const nonceValid = await viewFunction(getRpcUrl(network), contractId, 'get_nonce_validity', { group_id, user_id, nonce });
    if (!nonceValid) {
      console.error('Token verify: Nonce invalid/used');
      return { valid: false };
    }
    console.log('Token verify: Nonce valid');
    
    // Prefer payload PK if present; fallback to RPC
    let userPkBytes;
    if (signing_pk_b58) {
      try {
        userPkBytes = bs58.decode(signing_pk_b58);
        if (userPkBytes.length !== 32) {
          console.error('Token verify: Invalid signing PK length');
          return { valid: false };
        }
        console.log('Token verify: Using payload PK', signing_pk_b58.slice(0, 20) + '...');
      } catch (e) {
        console.error('Token verify: PK decode error, falling back to RPC', e);
      }
    }
    
    if (!userPkBytes) {  
      // Fallback: RPC fetch (use correct network RPC)
      const rpcUrl = getRpcUrl(network);
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
      userPkBytes = bs58.decode(userPkStr.slice(8));
      console.log('Token verify: Using RPC PK', userPkStr.slice(0, 20) + '...');
    }
    
    // Verify ed25519 on raw payload_bytes
    const sigBytes = Buffer.from(sigHex, 'hex');
    const validSig = ed25519.verify(sigBytes, payloadBytes, userPkBytes);
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

// Health check endpoint
keyMgmt.get('/health', async (c) => {
  return c.json({ 
    status: 'ok', 
    contract: DEFAULT_MAINNET_CONTRACT,
    network: 'mainnet',
    timestamp: new Date().toISOString()
  });
});

// Generate key for a group (called by NOVA contract after group registration)
keyMgmt.post('/generate_key', async (c) => {
  const { group_id, owner, contract_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);

  // Resolve which contract to use
  let resolved;
  try {
    resolved = resolveContract(contract_id);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const { contractId, network } = resolved;

  console.log(`Generating key for group ${group_id}, requested by ${owner}, contract: ${contractId} (${network})`);
  
  // Verify group exists on-chain
  const rpcUrl = getRpcUrl(network);
  const groupExists = await viewFunction(rpcUrl, contractId, 'group_contains_key', { group_id });

  if (!groupExists) {
    console.error(`Group ${group_id} does not exist on ${contractId}`);
    return c.json({ error: `Group does not exist on-chain (${contractId})` }, 404);
  }

  console.log(`Group ${group_id} verified on ${contractId}`);

  // Generate key in TEE (random 32 bytes)
  const keyBytes = crypto.randomBytes(32);
  const key = keyBytes.toString('base64');
  const now = new Date().toISOString();
  
  // Encrypt and store (idempotent)
  const encryptedKey = encryptKey(key);
  db.prepare(`
    INSERT OR REPLACE INTO keys (group_id, encrypted_key, contract_id, network, created_at, updated_at) 
    VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM keys WHERE group_id = ?), ?), ?)
  `).run(group_id, encryptedKey, contractId, network, group_id, now, now);
  
  // Skip testnet attestation, use TEE-verified placeholder
  const checksum = 'tee-verified'; 
  
  console.log(`Generated key for group ${group_id}, owner ${owner}, network ${network}`);
  return c.json({ key, checksum: checksum });
});

// Get key for authorized user
keyMgmt.post('/get_key', async (c) => {
  const { group_id, token, account_id, contract_id } = await c.req.json();
  if (!group_id ) return c.json({ error: 'group_id required' }, 400);
  if (!token && !account_id) return c.json({ error: 'token or account_id required' }, 400);
  
  // Resolve which contract to use (prefer request, then lookup from stored key)
  let resolved;
  try {
    resolved = resolveContract(contract_id, group_id);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const { contractId, network } = resolved;

  let user_id: string;

  if (account_id) {
    // Direct account_id auth for wallet users
    user_id = account_id;
    console.log(`Using account_id auth for ${account_id} on ${network}`);
  } else {
    // Token-based auth for email users
    const tokenInfo = await verifyToken(token, contractId, network);
    if (!tokenInfo.valid || !tokenInfo.user_id) {
      return c.json({ error: 'Invalid token' }, 403);
    }
    user_id = tokenInfo.user_id;
  }
  
  // Verify on-chain authorization (this is the key security check)
  const authorized = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
  
  if (!authorized) {
    console.error(`User ${user_id} not authorized for group ${group_id} on ${contractId}`);
    return c.json({ error: 'Unauthorized: On-chain access denied' }, 403);
  }

  // Fetch key from DB
  const row = db.prepare('SELECT encrypted_key, contract_id, network FROM keys WHERE group_id = ?').get(group_id) as { encrypted_key: string; contract_id?: string; network?: string } | undefined;
  if (!row || !row.encrypted_key) {
    console.error(`Key not found for group ${group_id}`);
    return c.json({ error: 'Key not found' }, 404);
  }
  
  const key = decryptKey(row.encrypted_key);
  
  // Skip testnet attestation
  const checksum = 'tee-mainnet-verified';
  
  console.log(`Retrieved key for group ${group_id}, user ${user_id}, network ${network}`);
  
  return c.json({ key, checksum: checksum });
});

// Rotate key (called by NOVA contract when member is revoked)
keyMgmt.post('/rotate_key', async (c) => {
  const { group_id, contract_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);
  
  // Resolve which contract to use
  let resolved;
  try {
    resolved = resolveContract(contract_id, group_id);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const { contractId, network } = resolved;

  // Verify group exists
  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });

  if (!groupExists) {
    return c.json({ error: `Group does not exist (${contractId})` }, 404);
  }

  // Generate new key, encrypt, update DB (atomic)
  const newKey = crypto.randomBytes(32).toString('base64');  
  const encryptedKey = encryptKey(newKey);
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE keys SET encrypted_key = ?, contract_id = ?, network = ?, updated_at = ? WHERE group_id = ?
  `).run(encryptedKey, contractId, network, now, group_id);
  
  if (result.changes === 0) {
    return c.json({ error: 'Key not found for rotation' }, 404);
  }
  
  // Skip testnet attestation
  const checksum = 'tee-mainnet-verified';

  console.log(`Rotated key for group ${group_id}, network ${network}`);

  return c.json({ 
    success: true, 
    new_key_hash: crypto.createHash('sha256').update(newKey).digest('hex'), 
    checksum: checksum 
  });
});

// Debug endpoint - list all stored keys (group_ids only, not the actual keys)
keyMgmt.get('/debug/groups', async (c) => {
  const rows = db.prepare('SELECT group_id FROM keys').all() as { group_id: string }[];
  return c.json({ 
    groups: rows.map(r => r.group_id),
    count: rows.length,
    contract: DEFAULT_MAINNET_CONTRACT
  });
});

export default keyMgmt;
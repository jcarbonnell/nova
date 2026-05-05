// Shade agent manages keys for NOVA groups in shade agent
import { Hono } from 'hono';
import crypto, { hkdfSync } from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

// ────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────

const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
const KV_CONTRACT_OWNER = process.env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near';

const DEFAULT_MAINNET_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk.near';
const DEFAULT_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT_ID || 'nova-sdk-6.testnet';

const ALLOWED_CONTRACTS = new Set([DEFAULT_MAINNET_CONTRACT, DEFAULT_TESTNET_CONTRACT]);

// ────────────────────────────────────────────────
// Master Seed & Derivation (shared with user-keys)
// ────────────────────────────────────────────────

let masterSeed: Uint8Array | null = null;

async function getMasterSeed(): Promise<Uint8Array> {
  if (masterSeed) return masterSeed;

  const MASTER_SEED_INIT_ALLOWED = process.env.MASTER_SEED_INIT_ALLOWED === 'true';
  
  // If MASTER_SEED_INIT_ALLOWED is true, force re-initialization
  if (MASTER_SEED_INIT_ALLOWED) {
    console.warn('⚠️  MASTER_SEED_INIT_ALLOWED=true: Force re-initializing master seed!');
    const sponsorKey = process.env.SPONSOR_PRIVATE_KEY as string;
    const sponsorKeyBytes = Buffer.from(sponsorKey.replace('ed25519:', ''), 'base64');
    const newSeed = crypto.createHash('sha256')
      .update(Buffer.concat([
        sponsorKeyBytes,
        Buffer.from('nova-master-seed-v1', 'utf8')
      ]))
      .digest();

    // SET MASTER SEED FIRST (before storing!)
    masterSeed = newSeed;  
    const encrypted = encryptBlob(newSeed);
    await storeBlobToKV('master-root', encrypted);
    console.log('✅ Master seed initialized and stored on-chain');
    return masterSeed;
  }

  // Otherwise, try to load existing seed
  const encryptedBlob = await getBlobFromKV('master-root');  
  if (encryptedBlob) {      
    masterSeed = decryptBlob(encryptedBlob);
    console.log('✅ Master seed loaded from KV');
    return masterSeed;
  }

  // No seed exists and init not allowed
  throw new Error(
    'Master seed not found in KV and MASTER_SEED_INIT_ALLOWED is not set. ' +
    'Set MASTER_SEED_INIT_ALLOWED=true on first deploy only, then remove it.'
  );
}

function deriveKey(salt: string, length: number = 32): Uint8Array {
  const master = getMasterSeedSync();
  const derived = hkdfSync(
    'sha256',
    master,
    Buffer.from(salt),
    Buffer.from('nova-v1'),
    length,
  );
  return new Uint8Array(derived);
}

function getMasterSeedSync(): Uint8Array {
  if (!masterSeed) throw new Error('Master seed not initialized');
  return masterSeed;
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

// ────────────────────────────────────────────────
// KV Helpers (same as user-keys)
// ────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', event: string, meta?: Record<string, unknown>) {
  console[level](JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
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

// Generic contract call broadcaster — reuses same signer keypair as storeBlobToKV
async function broadcastContractCall(
  contractId: string,
  network: string,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: string = '0',
): Promise<void> {
  const rpcUrl = network === 'testnet'
    ? 'https://rpc.testnet.near.org'
    : (process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org');
  const signerAccountId = `kv-signer.${KV_CONTRACT}`;

  const signerPriv = deriveKey('nova-signer-v1', 32);
  const signerPub = await ed25519.getPublicKeyAsync(signerPriv);
  const signerPubBs58 = `ed25519:${bs58.encode(signerPub)}`;

  log('info', 'broadcast_contract_call_attempt', {
    signerAccountId,
    signerPubBs58,
    contractId,
    methodName,
    depositYocto,
    rpcUrl,
  });

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
  const callArgs = Buffer.from(JSON.stringify(args));
  const deposit = BigInt(depositYocto);
  const action = encodeFunctionCallAction(methodName, callArgs, 50_000_000_000_000n, deposit);
  const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, contractId, blockHash, [action]);
  const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
  const signature = await ed25519.signAsync(txHash, signerPriv);
  const signedTx = Buffer.concat([txBytes, Buffer.from([0]), signature]);

  const broadcastResult = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'broadcast',
    method: 'broadcast_tx_commit',
    params: [signedTx.toString('base64')],
  }) as { transaction?: { hash: string }; status?: { Failure?: unknown } };

  if (broadcastResult?.status?.Failure) {
    throw new Error(`Contract call failed: ${JSON.stringify(broadcastResult.status.Failure)}`);
  }
  log('info', 'contract_call_committed', {
    contractId, methodName, txHash: broadcastResult?.transaction?.hash,
  });
}

// Signed transaction broadcast
async function storeBlobToKV(key: string, encryptedBlob: string): Promise<void> {
  const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org';
  const signerAccountId = KV_CONTRACT_OWNER;
  
  const signerPriv = deriveKey('kv-owner-signer-v1', 32);
  const signerPub = await ed25519.getPublicKeyAsync(signerPriv);
  const signerPubBs58 = `ed25519:${bs58.encode(signerPub)}`;

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
    
  if (!accessKeyResult || typeof accessKeyResult.nonce === 'undefined') {
    throw new Error(
      `Access key not found for ${signerAccountId} with public key ${signerPubBs58}\n` +
      `Please add the key with:\n` +
      `near add-key ${signerAccountId} ${signerPubBs58} --accountId nova-kv.near --networkId mainnet`
    );
  }
    
  const nonce = BigInt(accessKeyResult.nonce) + 1n;
  const blockHash = bs58.decode(accessKeyResult.block_hash);

  const [ivHex, encHex] = encryptedBlob.split(':');
  const rawBytes = Buffer.concat([Buffer.from(ivHex, 'hex'), Buffer.from(encHex, 'hex')]);
  const callArgs = Buffer.from(JSON.stringify({ key, encrypted_blob: Array.from(rawBytes) }));
  const action = encodeFunctionCallAction('store', callArgs, 30_000_000_000_000n, 0n);
  const txBytes = encodeTransaction(signerAccountId, signerPub, nonce, KV_CONTRACT, blockHash, [action]);

  const txHash = new Uint8Array(crypto.createHash('sha256').update(txBytes).digest());
  const signature = await ed25519.signAsync(txHash, signerPriv);

  const signedTx = Buffer.concat([
    txBytes,
    Buffer.from([0]),
    signature,
  ]);

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
  const rpcUrl = 'https://rpc.mainnet.near.org';
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

// ────────────────────────────────────────────────
// RPC View Helper (unchanged)
// ────────────────────────────────────────────────

async function viewFunction(rpcUrl: string, contractId: string, methodName: string, args: unknown): Promise<unknown> {
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

  const decoded = Buffer.from(result).toString('utf-8');
  try {
    return JSON.parse(decoded);
  } catch {
    return decoded === 'true';
  }
}

// ────────────────────────────────────────────────
// Existing Helpers (unchanged)
// ────────────────────────────────────────────────

function getRpcUrl(network: string): string {
  return network === 'testnet' ? 'https://rpc.testnet.near.org' : 'https://rpc.mainnet.near.org';
}

function resolveContract(requestContractId?: string, _groupId?: string): { contractId: string; network: string } {
  if (requestContractId && ALLOWED_CONTRACTS.has(requestContractId)) {
    const network = requestContractId.endsWith('.testnet') ? 'testnet' : 'mainnet';
    return { contractId: requestContractId, network };
  }

  // Default fallback
  return { contractId: DEFAULT_MAINNET_CONTRACT, network: 'mainnet' };
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
      const keyView = keys.find((k: { public_key: string }) => k.public_key.startsWith('ed25519:')) || keys[0];
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
    const validSig = await ed25519.verifyAsync(sigBytes, payloadBytes, userPkBytes);
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

const keyMgmt = new Hono();

// Validate env vars once when first request comes in
let envValidated = false;
keyMgmt.use('*', async (c, next) => {
  if (!envValidated) {
    const SHADE_AGENT_ACCOUNT_ID = process.env.SHADE_AGENT_ACCOUNT_ID;
    const TEE_SECRET = process.env.TEE_KEY_SECRET || '';
    
    if (!SHADE_AGENT_ACCOUNT_ID) throw new Error('SHADE_AGENT_ACCOUNT_ID required');
    if (!/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
      throw new Error('TEE_KEY_SECRET must be a 64-char hex string (32 bytes)');
    }
    envValidated = true;
  }
  await getMasterSeed();
  await next();
});

// Ensure master seed is loaded before any route handler runs
keyMgmt.use('*', async (c, next) => {
  await getMasterSeed();
  await next();
});

// Health - Ensure master seed + show status
keyMgmt.get('/health', async (c) => {
  try {
    const attestation = await getAttestation();
    return c.json({
      status: 'ok',
      contract: DEFAULT_MAINNET_CONTRACT,
      network: 'mainnet',
      timestamp: new Date().toISOString(),
      master_seed_status: 'initialized',
      attestation: attestation.provider,
      attestation_pcr0: attestation.pcr0,
      attestation_verified: attestation.verified,
    });
  } catch (err) {
    return c.json({ error: 'Health failed', details: (err as Error).message }, 500);
  }
});

// GENERATE KEY - Deterministic from master seed
keyMgmt.post('/generate_key', async (c) => {
  const { group_id, owner, contract_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);

  let resolved;
  try {
    resolved = resolveContract(contract_id);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { contractId, network } = resolved;

  // Verify group on-chain
  const rpcUrl = getRpcUrl(network);
  const groupExists = await viewFunction(rpcUrl, contractId, 'group_contains_key', { group_id });
  if (!groupExists) return c.json({ error: `Group not found on ${contractId}` }, 404);

  // Derive group key deterministically
  const salt = `group:${group_id}:${network}:${contractId}`;
  const keyBytes = deriveKey(salt, 32);
  const keyB64 = Buffer.from(keyBytes).toString('base64');

  // Encrypt and store blob on KV
  const encrypted = encryptBlob(keyBytes);
  const keyId = crypto.createHash('sha256').update(salt).digest('hex');
  await storeBlobToKV(keyId, encrypted);

  const checksum = 'derived-' + crypto.createHash('sha256').update(keyBytes).digest('hex').slice(0, 16);

  return c.json({ key: keyB64, checksum });
});

// GET KEY - Derive and return
keyMgmt.post('/get_key', async (c) => {
  const { group_id, token, account_id, contract_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);

  let resolved;
  try {
    resolved = resolveContract(contract_id, group_id);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { contractId, network } = resolved;

  let user_id: string;

  if (account_id) {
    user_id = account_id;
  } else {
    const tokenInfo = await verifyToken(token, contractId, network);
    if (!tokenInfo.valid || !tokenInfo.user_id) return c.json({ error: 'Invalid token' }, 403);
    user_id = tokenInfo.user_id;
  }

  const authorized = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
  if (!authorized) return c.json({ error: 'Unauthorized' }, 403);

  // Check if key has been rotated — look up stored version
  const versionKeyId = crypto.createHash('sha256').update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
  const versionBlob = await getBlobFromKV(versionKeyId);
  let version: string | null = null;
  if (versionBlob) {
    const combined = JSON.parse(Buffer.from(decryptBlob(versionBlob)).toString('utf8'));
    version = combined.version ?? null;
  }

  const salt = version
    ? `group:${group_id}:${network}:${contractId}:v${version}`
    : `group:${group_id}:${network}:${contractId}`;

  const keyBytes = deriveKey(salt, 32);
  const keyB64 = Buffer.from(keyBytes).toString('base64');

  return c.json({ key: keyB64, checksum: 'derived-verified' });
});

// REVOKE MEMBER + AUTO-ROTATE — single atomic operation
// Clients call this instead of calling nova-sdk.near directly
keyMgmt.post('/revoke_member', async (c) => {
  const { group_id, user_id, contract_id } = await c.req.json();
  if (!group_id || !user_id) return c.json({ error: 'group_id and user_id required' }, 400);

  let resolved;
  try {
    resolved = resolveContract(contract_id, group_id);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { contractId, network } = resolved;

  // 1. Verify group exists and user is currently a member
  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
  if (!groupExists) return c.json({ error: `Group not found on ${contractId}` }, 404);

  const isMember = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
  if (!isMember) return c.json({ error: 'User is not a member' }, 400);

  // 2. Broadcast revoke_group_member to nova-sdk.near
  await broadcastContractCall(
    contractId,
    network,
    'revoke_group_member',
    { group_id, user_id },
    '0',
  );
  log('info', 'member_revoked_on_chain', { group_id, user_id });

  // 3. Immediately rotate the group key
  const version = Date.now();
  const salt = `group:${group_id}:${network}:${contractId}:v${version}`;
  const newKeyBytes = deriveKey(salt, 32);
  const combined = JSON.stringify({ key: encryptBlob(newKeyBytes), version: version.toString() });
  const combinedEncrypted = encryptBlob(Buffer.from(combined, 'utf8'));
  const versionKeyId = crypto.createHash('sha256').update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
  await storeBlobToKV(versionKeyId, combinedEncrypted);

  log('info', 'key_auto_rotated', { group_id, version, revokedUser: user_id });

  return c.json({
    success: true,
    group_id,
    revoked_user_id: user_id,
    version,
    message: 'Member revoked and key rotated atomically',
  });
});

// ROTATE KEY - New deterministic key (different salt or version)
keyMgmt.post('/rotate_key', async (c) => {
  const { group_id, contract_id } = await c.req.json();
  if (!group_id) return c.json({ error: 'group_id required' }, 400);

  let resolved;
  try {
    resolved = resolveContract(contract_id, group_id);
  } catch (e: unknown) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const { contractId, network } = resolved;

  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
  if (!groupExists) return c.json({ error: `Group not found (${contractId})` }, 404);

  const version = Date.now();
  const salt = `group:${group_id}:${network}:${contractId}:v${version}`;
  const newKeyBytes = deriveKey(salt, 32);

  // Store new blob
  const encrypted = encryptBlob(newKeyBytes);
  const versionStr = version.toString();

  // Pack key + version into a single encrypted blob
  const combined = JSON.stringify({ key: encrypted, version: versionStr });
  const combinedEncrypted = encryptBlob(Buffer.from(combined, 'utf8'));
  const versionKeyId = crypto.createHash('sha256').update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
  await storeBlobToKV(versionKeyId, combinedEncrypted);

  const newKeyHash = crypto.createHash('sha256').update(newKeyBytes).digest('hex');

  return c.json({
    success: true,
    new_key_hash: newKeyHash,
    version,
    checksum: 'derived-verified',
  });
});

// Debug - List group IDs (view KV keys if possible, or placeholder)
keyMgmt.get('/debug/groups', async (c) => {
  // In real impl: view all keys from KV (if you add list method)
  return c.json({
    groups: ['example-group-1', 'example-group-2'],
    count: 2,
    contract: DEFAULT_MAINNET_CONTRACT,
    note: 'Full list requires KV list method',
  });
});

export default keyMgmt;
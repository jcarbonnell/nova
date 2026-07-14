// Shade agent manages keys for NOVA groups in shade agent
import { Hono } from 'hono';
import crypto from 'crypto';
import axios from 'axios';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { encryptBlob, decryptBlob, deriveKey } from '../lib/crypto.js';
import {
  getBlobFromKV,
  storeBlobToKV,
  rpcCallWithRetry,
  encodeFunctionCallAction,
  encodeTransaction,
  KV_CONTRACT,
} from '../lib/kv.js';
import { initializeMasterSeed } from '../lib/seed.js';
import { log } from '../lib/logger.js';

import { ApiError, errorHandler } from '../lib/errors.js';
import {
  validate, body, type ValidatedEnv,
  GenerateKeySchema, GetKeySchema, RevokeMemberSchema, RotateKeySchema,
} from '../lib/schemas.js';

// ────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────

const DEFAULT_MAINNET_CONTRACT = process.env.NOVA_CONTRACT_ID || 'nova-sdk.near';
const DEFAULT_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT_ID || 'nova-sdk-6.testnet';

const ALLOWED_CONTRACTS = new Set([DEFAULT_MAINNET_CONTRACT, DEFAULT_TESTNET_CONTRACT]);

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

// ────────────────────────────────────────────────
// RPC View Helper
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
    
    // SECURITY: always fetch the account's on-chain access keys and verify the signature. 
    // signing_pk_b58, if present, is used as a hint to select which on-chain key to check first (accounts may hold multiple keys); 
    // it must match an actual on-chain access key of user_id or the token is rejected.
    const rpcUrl = getRpcUrl(network);
    const rpcRes = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 'dontcare',
      method: 'query',
      params: {
        request_type: 'view_access_key_list',
        finality: 'final',
        account_id: user_id,
      },
    });
    if (rpcRes.status !== 200) {
      console.error('Token verify: RPC error', rpcRes.status, rpcRes.data?.error?.message || 'Unknown');
      return { valid: false };
    }
    const keys: { public_key: string }[] = rpcRes.data.result?.keys || [];
    if (keys.length === 0) {
      console.error('Token verify: No access keys for', user_id);
      return { valid: false };
    }

    // Collect all on-chain ed25519 keys for this account.
    const ed25519Keys = keys
      .map(k => k.public_key)
      .filter(pk => pk.startsWith('ed25519:'));
    if (ed25519Keys.length === 0) {
      console.error('Token verify: No ed25519 key found for', user_id);
      return { valid: false };
    }

    // If the caller supplied a hint key, it MUST be one of the on-chain keys.
    if (signing_pk_b58) {
      const hintFull = `ed25519:${signing_pk_b58}`;
      if (!ed25519Keys.includes(hintFull)) {
        console.error('Token verify: signing_pk_b58 not an on-chain key of', user_id);
        return { valid: false };
      }
    }

    // Verify the signature against each candidate on-chain key; accept if any match.
    // (If a hint was given and validated above, it is among these candidates.)
    const sigBytes = Buffer.from(sigHex, 'hex');
    let userPkBytes: Uint8Array | null = null;
    for (const pk of ed25519Keys) {
      const candidate = bs58.decode(pk.slice(8)); // strip "ed25519:"
      if (candidate.length !== 32) continue;
      if (await ed25519.verifyAsync(sigBytes, payloadBytes, candidate)) {
        userPkBytes = candidate;
        break;
      }
    }
    if (!userPkBytes) {
      console.error('Token verify: Sig does not match any on-chain key of', user_id);
      return { valid: false };
    }
    
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
const keyMgmt = new Hono<ValidatedEnv>();
keyMgmt.onError(errorHandler);

// ────────────────────────────────────────────────
// Internal Auth (MCP / frontend → Shade Agent)
// ────────────────────────────────────────────────
// Public HTTPS endpoint on Phala. Only MCP and the frontend's server-side
// routes should reach key operations; both hold INTERNAL_API_SECRET.
// SDKs never call these routes directly (they go through MCP /tools/*).
// Health endpoints are exempt so monitoring/liveness probes still work.
function checkInternalAuth(provided: string | undefined): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    log('error', 'internal_auth_misconfigured');
    return false; // fail closed
  }
  if (!provided) return false;
  const a = Buffer.from(secret, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

keyMgmt.use('*', async (c, next) => {
  // Exempt health check (GET /health on this router)
  const p = c.req.path;
  if (c.req.method === 'GET' && (p === '/api/key-management/health' || p === '/api/key-management/health/')) {
    return next();
  }
  if (!checkInternalAuth(c.req.header('x-internal-auth'))) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  await next();
});

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
  await initializeMasterSeed();
  await next();
});

// Health - Ensure master seed + show status
keyMgmt.get('/health', async (c) => {
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
});

// GENERATE KEY - Deterministic from master seed
keyMgmt.post('/generate_key', validate(GenerateKeySchema), async (c) => {
  const { group_id, contract_id } = body(c, GenerateKeySchema);

  const { contractId, network } = resolveContract(contract_id);

  // Verify group on-chain
  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
  if (!groupExists) throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found on ${contractId}`);

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
keyMgmt.post('/get_key', validate(GetKeySchema), async (c) => {
  const { group_id, token, account_id, contract_id } = body(c, GetKeySchema);

  const { contractId, network } = resolveContract(contract_id, group_id);

  let user_id: string;

  if (account_id) {
    user_id = account_id;
  } else {
    if (!token) throw new ApiError(400, 'AUTH_REQUIRED', 'account_id or token required');
    const tokenInfo = await verifyToken(token, contractId, network);
    if (!tokenInfo.valid || !tokenInfo.user_id) throw new ApiError(403, 'INVALID_TOKEN', 'Invalid token');
    user_id = tokenInfo.user_id;
  }

  const authorized = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
  if (!authorized) throw new ApiError(403, 'UNAUTHORIZED', 'Unauthorized');

  // Check if key has been rotated — look up stored version
  const versionKeyId = crypto.createHash('sha256')
    .update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
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
keyMgmt.post('/revoke_member', validate(RevokeMemberSchema), async (c) => {
  const { group_id, user_id, contract_id } = body(c, RevokeMemberSchema);

  const { contractId, network } = resolveContract(contract_id, group_id);

  // 1. Verify group exists and user is currently a member
  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
  if (!groupExists) throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found on ${contractId}`);

  const isMember = await viewFunction(getRpcUrl(network), contractId, 'is_authorized', { group_id, user_id });
  if (!isMember) throw new ApiError(400, 'NOT_A_MEMBER', 'User is not a member');

  // 2. Broadcast revoke_group_member to nova-sdk.near
  await broadcastContractCall(contractId, network, 'revoke_group_member', { group_id, user_id }, '0');
  log('info', 'member_revoked_on_chain', { group_id, user_id });

  // 3. Immediately rotate the group key
  const version = Date.now();
  const salt = `group:${group_id}:${network}:${contractId}:v${version}`;
  const newKeyBytes = deriveKey(salt, 32);
  const combined = JSON.stringify({ key: encryptBlob(newKeyBytes), version: version.toString() });
  const combinedEncrypted = encryptBlob(Buffer.from(combined, 'utf8'));
  const versionKeyId = crypto.createHash('sha256')
    .update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
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
keyMgmt.post('/rotate_key', validate(RotateKeySchema), async (c) => {
  const { group_id, contract_id } = body(c, RotateKeySchema);

  const { contractId, network } = resolveContract(contract_id, group_id);

  const groupExists = await viewFunction(getRpcUrl(network), contractId, 'group_contains_key', { group_id });
  if (!groupExists) throw new ApiError(404, 'GROUP_NOT_FOUND', `Group not found (${contractId})`);

  const version = Date.now();
  const salt = `group:${group_id}:${network}:${contractId}:v${version}`;
  const newKeyBytes = deriveKey(salt, 32);

  // Pack key + version into a single encrypted blob
  const combined = JSON.stringify({ key: encryptBlob(newKeyBytes), version: version.toString() });
  const combinedEncrypted = encryptBlob(Buffer.from(combined, 'utf8'));
  const versionKeyId = crypto.createHash('sha256')
    .update(`group-version:${group_id}:${network}:${contractId}`).digest('hex');
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
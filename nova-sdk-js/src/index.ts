// nova/nova-sdk-js/src/index.ts
import { JsonRpcProvider } from '@near-js/providers';
import axios from 'axios';
import { Buffer } from 'buffer';

// NovaError moved to ./errors.js; re-exported below so the public API is unchanged.
export { NovaError } from './errors.js';
import { NovaError } from './errors.js';

// File-format codec (v0 legacy + v1) and the version dispatcher.
export { encodeFile, decodeFile } from './format.js';
export type { FileFormat, FileFormatV1, CompressionAlgo, EncodeOptions } from './format.js';

// v0 wire codec is the frozen legacy path (kept as the current upload/retrieve
// codec until the post-Step-4 wiring flip switches new uploads to v1).
import { encryptV0 as encryptData, decryptV0 as decryptData } from './legacy/v0.js';
import { encodeFile, decodeFile, FileFormat } from './format.js';
export { encryptV0, decryptV0 } from './legacy/v0.js';

// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const DEFAULT_RPC_URL = 'https://rpc.mainnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk.near';
const DEFAULT_AUTH_URL = 'https://nova-sdk.com';

export interface NovaSdkConfig {
  // API key for authentication (get yours at nova-sdk.com)
  apiKey?: string;
  
  // Infrastructure config
  authUrl?: string;
  
  // Network config
  rpcUrl?: string;
  contractId?: string;
  mcpUrl?: string;
}

// Type for NEAR RPC call_function response
interface CallFunctionResponse {
  result: number[];
  logs: string[];
  block_height: number;
  block_hash: string;
}

export interface Transaction {
  group_id: string;
  user_id: string;
  file_hash: string;
  ipfs_hash: string;
}

export interface UploadResult {
  cid: string;
  trans_id: string;
  file_hash: string;
}

export interface RetrieveResult {
  data: Buffer;
  ipfs_hash: string;
  group_id: string;
}

export interface AuthStatusResult {
  authenticated: boolean;
  near_account_id?: string;
  authorized_for_group?: boolean;
}

// Internal types
interface TokenCache {
  token: string;
  expiresAt: number;
}

interface PrepareUploadResponse {
  upload_id: string;
  key: string;
  group_id: string;
  filename: string;
}

interface FinalizeUploadResponse {
  location: string;
  cid: string;
  trans_id: string;
  file_hash: string;
}

interface PrepareRetrieveResponse {
  key: string;
  encrypted_b64: string;
  ipfs_hash: string;
  location: string;
  group_id: string;
  format: FileFormat | null;
}

function computeSha256(data: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function computeSha256Async(data: Buffer): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== 'undefined') {
    // Create a plain ArrayBuffer copy to avoid TypeScript issues with Buffer's ArrayBufferLike
    const dataArrayBuffer = new ArrayBuffer(data.length);
    const dataView = new Uint8Array(dataArrayBuffer);
    for (let i = 0; i < data.length; i++) {
      dataView[i] = data[i];
    }
    
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', dataArrayBuffer);
    return Buffer.from(hashBuffer).toString('hex');
  }
  // Node.js fallback
  const crypto = await import('crypto');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Main SDK Class
export class NovaSdk {
  private provider: JsonRpcProvider;
  private tokenCache: TokenCache | null = null;
  private authUrl: string;
  private apiKey: string | null = null;

  public readonly accountId: string;
  public readonly contractId: string;
  public readonly mcpUrl: string;
  public readonly rpcUrl: string;
  public readonly networkId: string;

  /**
   * Create a new NOVA SDK instance.
   * 
   * @param accountId - Your NOVA account (e.g., "alice.nova-sdk.near")
   * @param config - Optional configuration. If sessionToken is not provided,
   *                 the SDK will automatically fetch and refresh tokens.
   * 
   * @example
   * // Simplest usage - auto token management
   * const sdk = new NovaSdk('alice.nova-sdk.near');
   * 
   * @example
   * // With pre-fetched token
   * const sdk = new NovaSdk('alice.nova-sdk.near', { sessionToken: 'eyJ...' });
   * 
   * @example
   * // mainnet configuration
   * const sdk = new NovaSdk('alice.nova-sdk.near', {
   *   rpcUrl: 'https://rpc.mainnet.near.org',
   *   contractId: 'nova-sdk.near',
   * });
   */
  constructor(accountId: string, config: NovaSdkConfig = {}) {
    if (!accountId || typeof accountId !== 'string') {
      throw new NovaError('accountId required: get yours at nova-sdk.com');
    }

    this.accountId = accountId;
    this.authUrl = config.authUrl || DEFAULT_AUTH_URL;
    this.apiKey = config.apiKey || null;
    this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
    this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
    this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
    this.provider = new JsonRpcProvider({ url: this.rpcUrl });
  
    // Auto-detect network
    this.networkId = this.detectNetwork();
    
    // Validate mainnet contract
    if (this.networkId === 'mainnet' && !this.isValidMainnetContract()) {
      throw new NovaError(
        `Invalid mainnet contract: ${this.contractId}. Must end with .near`
      );
    }

    if (this.networkId === 'mainnet') {
      console.warn('⚠️  MAINNET MODE: Operations use real NEAR tokens.');
      console.warn('📋 Contract:', this.contractId);
      console.warn('💰 Check costs at: https://github.com/jcarbonnell/nova');
    }
  }

  // Token Management (auto-fetch and refresh)
  /**
   * Get a valid session token, fetching or refreshing if needed.
   * Called automatically before each API request.
   */
  private async getSessionToken(): Promise<string> {
    // Return cached token if still valid (5 min buffer for safety)
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
      return this.tokenCache.token;
    }

    // Fetch new token
    console.log('🔑 Fetching session token for:', this.accountId);

    if (!this.apiKey) {
      throw new NovaError('API key required. Get yours at nova-sdk.com');
    }

    try {
      const response = await axios.post(
        `${this.authUrl}/api/auth/session-token`,
        { account_id: this.accountId },
        { 
          headers: { 
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
          },
          timeout: 15000,
        }
      );

      const { token, expires_in, account_id } = response.data;

      if (!token) {
        throw new NovaError('No token in response - account may not exist');
      }

      // Verify account_id matches
      if (account_id && account_id !== this.accountId) {
        console.warn(`Account ID mismatch: requested ${this.accountId}, got ${account_id}`);
      }

      // Parse expires_in (e.g., "24h")
      const expiresMs = this.parseExpiry(expires_in || '24h');

      this.tokenCache = {
        token,
        expiresAt: Date.now() + expiresMs,
      };

      console.log('✅ Session token obtained, expires in:', expires_in || '24h');
      return token;

    } catch (e) {
      if (axios.isAxiosError(e)) {
        const status = e.response?.status;
        const msg = e.response?.data?.error || e.message;
        
        if (status === 404) {
          throw new NovaError(
            `Account '${this.accountId}' not found. Create one at nova-sdk.com first.`,
            e
          );
        }
        throw new NovaError(`Failed to get session token: ${msg}`, e);
      }
      throw new NovaError(`Failed to get session token: ${e}`, e as Error);
    }
  }

  private parseExpiry(expiresIn: string): number {
    const match = expiresIn.match(/^(\d+)([hmd])$/);
    if (!match) return 23 * 60 * 60 * 1000; // Default 23h

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 23 * 60 * 60 * 1000;
    }
  }

  /**
   * Force refresh the session token.
   * Useful if you get auth errors and want to retry with a fresh token.
   */
  async refreshToken(): Promise<void> {
    this.tokenCache = null;
    await this.getSessionToken();
  }

  // Network detection
  private detectNetwork(): string {
    if (this.contractId.endsWith('.testnet')) return 'testnet';
    if (this.contractId.endsWith('.near')) return 'mainnet';
    if (this.rpcUrl.includes('testnet')) return 'testnet';
    if (this.rpcUrl.includes('mainnet')) return 'mainnet';
    
    // Default to mainnet
    console.warn('⚠️  Network auto-detection failed, defaulting to mainnet');
    return 'mainnet';
  }

  private isValidMainnetContract(): boolean {
    return this.contractId.endsWith('.near');
  }

  // Get network info (for debugging)
  public getNetworkInfo(): { 
    networkId: string; 
    contractId: string; 
    rpcUrl: string;
    mcpUrl: string;
    authUrl: string;
  } {
    return {
      networkId: this.networkId,
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      mcpUrl: this.mcpUrl,
      authUrl: this.authUrl,
    };
  }

  // MCP Communication 
  private async getMcpHeaders(): Promise<Record<string, string>> {
    const token = await this.getSessionToken();
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-account-id': this.accountId,
      'x-wallet-id': this.accountId,
    };
  }

  // MCP Tool Invocations - Call an MCP tool directly.
  private async callMcpTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    try {
      const headers = await this.getMcpHeaders();
      const response = await axios.post(
        `${this.mcpUrl}/tools/${toolName}`,
        args,
        { headers, timeout: 60000 }
      );
      // Unwrap { result: ... } envelope added by expose_as_rest decorator
      const data = response.data;
      if (data && typeof data === 'object' && 'result' in data) {
        return data.result as T;
      }
      return data as T;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
        throw new NovaError(`MCP tool '${toolName}' failed: ${errorMsg}`, e);
      }
      throw new NovaError(`MCP tool '${toolName}' failed: ${e}`, e as Error);
    }
  }

  // Core NOVA Operations (via MCP)
  // Check authentication status and group authorization.
  async authStatus(groupId: string = 'default'): Promise<AuthStatusResult> {
    return this.callMcpTool<AuthStatusResult>('auth_status', { group_id: groupId });
  }

  // List groups the authenticated account owns. Routed through MCP: the owning
  // account is derived from the verified session (no arg passed, so no
  // client-supplied account can be spoofed). Returns [] when none are owned.
  async getOwnedGroups(): Promise<string[]> {
    return this.callMcpTool<string[]>('get_owned_groups', {});
  }

  // List groups the authenticated account is a member of. Same MCP-session
  // identity model as getOwnedGroups. Returns [] when a member of none.
  async getMemberGroups(): Promise<string[]> {
    return this.callMcpTool<string[]>('get_member_groups', {});
  }

  // List the members of a group. Routed through MCP because the underlying
  // contract read is authorization-gated; an unauthorized caller is rejected by
  // the contract and surfaced here as a NovaError. Caller must be authorized
  // on the group.
  async getGroupMembers(groupId: string): Promise<string[]> {
    return this.callMcpTool<string[]>('get_group_members', { group_id: groupId });
  }

  // Register a new group. Caller becomes owner.
  async registerGroup(groupId: string): Promise<string> {
    const result = await this.callMcpTool<{ message?: string }>('register_group', { 
      group_id: groupId 
    });
    return result.message || `Group '${groupId}' registered successfully`;
  }

  // Add a member to a group. Caller must be owner.
  async addGroupMember(groupId: string, memberId: string): Promise<string> {
    const result = await this.callMcpTool<{ message?: string }>('add_group_member', {
      group_id: groupId,
      member_id: memberId,
    });
    return result.message || `Added ${memberId} to group '${groupId}'`;
  }

  // Set (or clear, with null) a group's retention window in days (§6.1). Owner only.
  // null ⇒ no auto-expiry (the default). Files past the window become eligible for
  // retention-driven deletion; this configures the window only, it deletes nothing.
  async setGroupRetention(groupId: string, retentionDays: number | null): Promise<string> {
    const result = await this.callMcpTool<{ message?: string }>('set_group_retention', {
      group_id: groupId,
      retention_days: retentionDays,
    });
    return result.message || (
      retentionDays === null
        ? `Cleared retention for group '${groupId}'`
        : `Set retention for group '${groupId}' to ${retentionDays} days`
    );
  }

  /**
   * Self-join an OPEN group (hackathon submission groups). The caller joins
   * themselves — no owner action needed. Only works on groups the owner has
   * opened for join; otherwise the contract rejects it.
   *
   * Idempotent-safe: if already a member, resolves without error rather than
   * throwing on the contract's "Already a member" panic.
   */
  async joinGroup(groupId: string): Promise<string> {
    // Skip the join if already authorized — avoids the contract's
    // "Already a member" panic on re-submit.
    try {
      if (await this.isAuthorized(groupId)) {
        return `Already a member of '${groupId}'`;
      }
    } catch {
      // isAuthorized can throw if the group doesn't exist yet; let join surface it.
    }
    const result = await this.callMcpTool<{ message?: string } | string>('join_group', {
      group_id: groupId,
    });
    if (typeof result === 'string') return result;
    return result.message || `Joined group '${groupId}'`;
  }

  // Revoke a member from a group. Caller must be owner.
  async revokeGroupMember(groupId: string, memberId: string): Promise<string> {
    const result = await this.callMcpTool<{ message?: string }>('revoke_group_member', {
      group_id: groupId,
      member_id: memberId,
    });
    return result.message || `Revoked ${memberId} from group '${groupId}'`;
  }

  /**
   * Upload a file with end-to-end encryption
   * 
   * Flow:
   * 1. SDK calls prepare_upload to get encryption key
   * 2. SDK encrypts data locally (AES-256-GCM)
   * 3. SDK calls finalize_upload with encrypted data
   * 4. MCP uploads to IPFS and records on NEAR
   * 
   * @param groupId - The group to upload to
   * @param data - Raw file data as Buffer
   * @param filename - Name of the file
   * @returns Upload result with CID and transaction ID
   */
  async upload(
    groupId: string, 
    data: Buffer, 
    filename: string
  ): Promise<UploadResult> {
    // Step 1: Get encryption key from MCP
    const prepareResult = await this.callMcpTool<PrepareUploadResponse>('prepare_upload', {
      group_id: groupId,
      filename,
    });

    const { upload_id, key } = prepareResult;

    // Step 2: Encode to the v1 format (optional deflate + v0 AES-GCM) with the
    // per-file key from prepare_upload. `format` is persisted by Shade and returned
    // at retrieve so decodeFile can dispatch.
    const { bytes_b64, format } = await encodeFile(data, key);

    // Step 3: Compute hash of PLAINTEXT (the on-chain integrity anchor — unchanged).
    const fileHash = await computeSha256Async(data);

    // Step 4: Finalize upload via MCP tool
    const finalizeResult = await this.callMcpTool<FinalizeUploadResponse>(
      'finalize_upload',
      {
        upload_id,
        encrypted_data: bytes_b64,
        file_hash: fileHash,
        format,
      }
    );

    return {
      cid: finalizeResult.location ?? finalizeResult.cid,
      trans_id: finalizeResult.trans_id,
      file_hash: finalizeResult.file_hash,
    };
  }

  /**
   * Retrieve and decrypt a file
   * 
   * Flow:
   * 1. Call prepare_retrieve to get key and encrypted data
   * 2. Decrypt data locally (client-side)
   * 
   * @param groupId - The group the file belongs to
   * @param ipfsHash - The IPFS CID of the file
   * @returns Decrypted file data
   */
  async retrieve(
    groupId: string, 
    ref: string
  ): Promise<RetrieveResult> {
    // `ref` is whatever the on-chain record stored: a legacy IPFS CID OR a FastFS
    // location ({pred}/{recv}/{rel}). No CID prefix guard — MCP dispatches, and a
    // malformed ref surfaces a clear error from the FastFS branch.
    if (!ref) throw new NovaError('retrieve requires a file reference (CID or FastFS location)');

    // Step 1: Get key, ciphertext, and format from MCP
    const prepareResult = await this.callMcpTool<PrepareRetrieveResponse>('prepare_retrieve', {
      group_id: groupId,
      ipfs_hash: ref,   // MCP's param is still named ipfs_hash; it carries the ref
    });

    const { key, encrypted_b64, ipfs_hash, group_id, format } = prepareResult;

    // Step 2: Decode locally — decodeFile dispatches on format (v1 FastFS vs v0
    // legacy). null/absent format ⇒ v0 legacy path (frozen decryptV0).
    const decryptedData = await decodeFile(encrypted_b64, key, format ?? null);

    return {
      data: decryptedData,
      ipfs_hash,
      group_id,
    };
  }

  // Read-Only Contract Queries (Direct RPC - no auth needed)
  async getBalance(accountId?: string): Promise<string> {
    const id = accountId || this.accountId;
    try {
      const accountView = await this.provider.viewAccount(id);
      return accountView.amount.toString();
    } catch (e) {
      throw new NovaError(`Balance query error: ${e}`, e as Error);
    }
  }

  async isAuthorized(groupId: string, userId?: string): Promise<boolean> {
    const id = userId || this.accountId;
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'is_authorized',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId, user_id: id })).toString('base64'),
        finality: 'final',
      });
      
      const callResult = result as unknown as CallFunctionResponse;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return JSON.parse(decoded) as boolean;
    } catch (e) {
      throw new NovaError(`Authorization check error: ${e}`, e as Error);
    }
  }

  async getGroupChecksum(groupId: string): Promise<string | null> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'get_group_checksum',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId })).toString('base64'),
        finality: 'final',
      });
    
      const callResult = result as unknown as CallFunctionResponse;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return decoded ? JSON.parse(decoded) : null;
    } catch (e) {
      throw new NovaError(`Checksum fetch error: ${e}`, e as Error);
    }
  }

  async getGroupOwner(groupId: string): Promise<string | null> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'get_group_owner',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId })).toString('base64'),
        finality: 'final',
      });
    
      const callResult = result as unknown as CallFunctionResponse;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return decoded ? JSON.parse(decoded) : null;
    } catch (e) {
      throw new NovaError(`Owner fetch error: ${e}`, e as Error);
    }
  }

  async estimateFee(action: string): Promise<bigint> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'estimate_fee',
        args_base64: Buffer.from(JSON.stringify({ action })).toString('base64'),
        finality: 'final',
      });
      const callResult = result as unknown as CallFunctionResponse;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return BigInt(decoded);
    } catch (e) {
      throw new NovaError(`Fee estimate error: ${e}`, e as Error);
    }
  }

  async getTransactionsForGroup(groupId: string, userId?: string): Promise<Transaction[]> {
    const id = userId || this.accountId;
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'get_transactions_for_group',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId, user_id: id })).toString('base64'),
        finality: 'final',
      });
      
      const callResult = result as unknown as CallFunctionResponse;
      const decoded = Buffer.from(callResult.result).toString();
      return JSON.parse(decoded) as Transaction[];
    } catch (e) {
      throw new NovaError(`Transactions query error: ${e}`, e as Error);
    }
  }

  // Utility Methods
  /** Compute SHA256 hash of data (synchronous, Node.js only) */
  computeHash(data: Buffer): string {
    return computeSha256(data);
  }

  /** Compute SHA256 hash of data (async, works everywhere) */
  async computeHashAsync(data: Buffer): Promise<string> {
    return computeSha256Async(data);
  }

  // Legacy Methods (deprecated)
  /** @deprecated Use upload() instead */
  async compositeUpload(
    groupId: string, 
    data: Buffer, 
    filename: string
  ): Promise<UploadResult> {
    console.warn('compositeUpload() is deprecated, use upload() instead');
    return this.upload(groupId, data, filename);
  }

  /** @deprecated Use retrieve() instead */
  async compositeRetrieve(
    groupId: string, 
    ipfsHash: string
  ): Promise<RetrieveResult> {
    console.warn('compositeRetrieve() is deprecated, use retrieve() instead');
    return this.retrieve(groupId, ipfsHash);
  }
}
// nova/nova-sdk-js/src/index.ts
import { JsonRpcProvider } from '@near-js/providers';
import axios from 'axios';
import { Buffer } from 'buffer';

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
  cid: string;
  trans_id: string;
  file_hash: string;
}

interface PrepareRetrieveResponse {
  key: string;
  encrypted_b64: string;
  ipfs_hash: string;
  group_id: string;
}

export class NovaError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'NovaError';
  }
}

// encryption helpers (AES-256-GCM)
async function encryptData(data: Buffer, keyB64: string): Promise<string> {
  // Node.js environment
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const crypto = await import('crypto');
    const keyBytes = Buffer.from(keyB64, 'base64');
    const iv = crypto.randomBytes(12);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    // Format: IV (12) + ciphertext + authTag (16)
    const result = Buffer.concat([iv, encrypted, authTag]);
    return result.toString('base64');
  }
  
  // Browser/Deno: use SubtleCrypto
  const keyBytes = new Uint8Array(Buffer.from(keyB64, 'base64'));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  // Create a plain ArrayBuffer copy to avoid TypeScript issues with Buffer's ArrayBufferLike
  const dataArrayBuffer = new ArrayBuffer(data.length);
  const dataView = new Uint8Array(dataArrayBuffer);
  for (let i = 0; i < data.length; i++) {
    dataView[i] = data[i];
  }
  
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    dataArrayBuffer
  );
  
  // Combine IV + ciphertext (which includes auth tag in SubtleCrypto)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  
  return Buffer.from(result).toString('base64');
}

async function decryptData(encryptedB64: string, keyB64: string): Promise<Buffer> {
  const encryptedBytes = Buffer.from(encryptedB64, 'base64');
  const keyBytes = Buffer.from(keyB64, 'base64');
  
  // For Node.js environment
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const crypto = await import('crypto');
    
    const iv = encryptedBytes.subarray(0, 12);
    const authTag = encryptedBytes.subarray(encryptedBytes.length - 16);
    const ciphertext = encryptedBytes.subarray(12, encryptedBytes.length - 16);
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted;
  }
  
  // Browser/Deno: use SubtleCrypto
  const iv = encryptedBytes.subarray(0, 12);
  const ciphertext = encryptedBytes.subarray(12); // Includes auth tag
  
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  );
  
  return Buffer.from(decrypted);
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

    // Step 2: Encrypt data locally
    const encryptedB64 = await encryptData(data, key);

    // Step 3: Compute hash of plaintext
    const fileHash = await computeSha256Async(data);

    // Step 4: Finalize upload via MCP tool
    const finalizeResult = await this.callMcpTool<FinalizeUploadResponse>(
      'finalize_upload',
      {
        upload_id,
        encrypted_data: encryptedB64,
        file_hash: fileHash,
      }
    );

    return {
      cid: finalizeResult.cid,
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
    ipfsHash: string
  ): Promise<RetrieveResult> {
    if (!ipfsHash.startsWith('Qm') && !ipfsHash.startsWith('bafy')) {
      throw new NovaError(`Invalid CID: ${ipfsHash}`);
    }

    // Step 1: Get key and encrypted data from MCP
    const prepareResult = await this.callMcpTool<PrepareRetrieveResponse>('prepare_retrieve', {
      group_id: groupId,
      ipfs_hash: ipfsHash,
    });

    const { key, encrypted_b64, ipfs_hash, group_id } = prepareResult;

    // Step 2: Decrypt data locally
    const decryptedData = await decryptData(encrypted_b64, key);

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
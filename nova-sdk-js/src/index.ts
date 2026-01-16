// nova/nova-sdk-js/src/index.ts
import { JsonRpcProvider } from '@near-js/providers';
import axios from 'axios';
import { Buffer } from 'buffer';

// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://nova-mcp.fastmcp.app';
const DEFAULT_RPC_URL = 'https://rpc.mainnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk.near';

export interface NovaSdkConfig {
  sessionToken: string;
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

export interface FeeBreakdown {
  claim: number;
  record?: number;
  total: number;
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

// Internal types for MCP responses
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

// encryption helpers
async function encryptData(data: Buffer, keyB64: string): Promise<string> {
  // For Node.js environment
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    // Node.js: use native crypto
    const crypto = await import('crypto');
    const keyBytes = Buffer.from(keyB64, 'base64');
    const iv = crypto.randomBytes(12); // GCM uses 12-byte IV
    
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
  // For Node.js - synchronous
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

export class NovaSdk {
  private provider: JsonRpcProvider;
  private sessionToken: string;
  public readonly accountId: string;
  public readonly contractId: string;
  public readonly mcpUrl: string;
  public readonly rpcUrl: string;
  public readonly networkId: string;

  constructor(accountId: string, config: NovaSdkConfig) {
    if (!accountId || typeof accountId !== 'string') {
      throw new NovaError('accountId required: get yours at nova-sdk.com');
    }
    if (!config?.sessionToken) {
      throw new NovaError('sessionToken required: get yours at nova-sdk.com/api/auth/session-token');
    }

    this.accountId = accountId;
    this.sessionToken = config.sessionToken;
    this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
    this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
    this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
    this.provider = new JsonRpcProvider({ url: this.rpcUrl });
  
    // Auto-detect network
    this.networkId = this.detectNetwork();
    
    // Validate mainnet contract
    if (this.networkId === 'mainnet' && !this.isValidMainnetContract()) {
      throw new NovaError(
        `Invalid mainnet contract: ${this.contractId}. Must end with .near or .mainnet`
      );
    }

    if (this.networkId === 'mainnet') {
      console.warn('⚠️  MAINNET MODE: Operations use real NEAR tokens.');
      console.warn('📋 Contract:', this.contractId);
      console.warn('💰 Check costs at: https://nova-sdk.com/pricing');
    }
  }

  // Network detection
  private detectNetwork(): string {
    // Heuristic 1: Contract ID suffix
    if (this.contractId.endsWith('.testnet')) return 'testnet';
    if (this.contractId.endsWith('.near') || this.contractId.endsWith('.mainnet')) {
      return 'mainnet';
    }
    
    // Heuristic 2: RPC URL
    if (this.rpcUrl.includes('testnet')) return 'testnet';
    if (this.rpcUrl.includes('mainnet')) return 'mainnet';
    
    // Default to mainnet for safety (v1.0.0+)
    console.warn('⚠️  Network auto-detection failed, defaulting to mainnet');
    return 'mainnet';
  }

  private isValidMainnetContract(): boolean {
    return this.contractId.endsWith('.near') || this.contractId.endsWith('.mainnet');
  }

  // Get network info (for debugging)
  public getNetworkInfo(): { 
    networkId: string; 
    contractId: string; 
    rpcUrl: string;
    mcpUrl: string;
  } {
    return {
      networkId: this.networkId,
      contractId: this.contractId,
      rpcUrl: this.rpcUrl,
      mcpUrl: this.mcpUrl,
    };
  }

  // Build HTTP headers for MCP server authentication. 
  private getMcpHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.sessionToken}`,
      'X-Account-Id': this.accountId,
    };
  }

  // MCP Tool Invocations - Call an MCP tool directly.
  private async callMcpTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    try {
      const response = await axios.post(
        `${this.mcpUrl}/tools/${toolName}`,
        args,
        {
          headers: this.getMcpHeaders(),
          timeout: 60000,
        }
      );

      return response.data as T;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
        throw new NovaError(`MCP tool '${toolName}' failed: ${errorMsg}`, e);
      }
      throw new NovaError(`MCP tool '${toolName}' failed: ${e}`, e as Error);
    }
  }

  // HTTP endpoint call (for finalize_upload)
  private async callHttpEndpoint<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    try {
      const response = await axios.post(
        `${this.mcpUrl}${endpoint}`,
        body,
        {
          headers: this.getMcpHeaders(),
          timeout: 60000,
        }
      );
      return response.data as T;
    } catch (e) {
      if (axios.isAxiosError(e)) {
        const errorMsg = e.response?.data?.error || e.response?.data?.message || e.message;
        throw new NovaError(`HTTP endpoint '${endpoint}' failed: ${errorMsg}`, e);
      }
      throw new NovaError(`HTTP endpoint '${endpoint}' failed: ${e}`, e as Error);
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

  // Revoke a member from a group. Caller must be owner.
  async revokeGroupMember(groupId: string, memberId: string): Promise<string> {
    const result = await this.callMcpTool<{ message?: string }>('revoke_group_member', {
      group_id: groupId,
      member_id: memberId,
    });
    return result.message || `Revoked ${memberId} from group '${groupId}'`;
  }

  /**
   * Upload a file to IPFS with encryption and blockchain recording.
   * 
   * Flow:
   * 1. Call prepare_upload to get encryption key
   * 2. Encrypt data locally (client-side)
   * 3. Call finalize_upload with encrypted data
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

    // Step 4: Finalize upload
    const finalizeResult = await this.callHttpEndpoint<FinalizeUploadResponse>(
      '/api/finalize-upload',
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
   * Retrieve and decrypt a file from IPFS.
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

  // Legacy method names for backwards compatibility (deprecated)
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

  /** Compute SHA256 hash of data (synchronous, Node.js only) */
  computeHash(data: Buffer): string {
    return computeSha256(data);
  }

  /** Compute SHA256 hash of data (async, works everywhere) */
  async computeHashAsync(data: Buffer): Promise<string> {
    return computeSha256Async(data);
  }
}
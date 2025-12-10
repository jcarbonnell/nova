// nova/nova-sdk-js/src/index.ts
import { JsonRpcProvider } from '@near-js/providers';
import axios from 'axios';
import * as crypto from 'crypto';
import { Buffer } from 'buffer';

// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://nova-mcp.fastmcp.app';
const DEFAULT_RPC_URL = 'https://rpc.testnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk-5.testnet';

export interface NovaSdkConfig {
  sessionToken: string;  // Required: JWT from nova-sdk.com
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

export interface CompositeUploadResult {
  cid: string;
  trans_id: string;
  file_hash: string;
  fee_breakdown: FeeBreakdown;
}

export interface CompositeRetrieveResult {
  data: Buffer;
  file_hash: string;
  fee_breakdown: FeeBreakdown;
  ipfs_hash: string;
  group_id: string;
}

export interface AuthStatusResult {
  authenticated: boolean;
  near_account_id?: string;
  authorized_for_group?: boolean;
}

export class NovaError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'NovaError';
  }
}

export class NovaSdk {
  private provider: JsonRpcProvider;
  private sessionToken: string;
  public readonly accountId: string;
  public readonly contractId: string;
  public readonly mcpUrl: string;
  public readonly rpcUrl: string;

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
  }

  // Build HTTP headers for MCP server authentication. 
  // Includes JWT session token for ownership verification.
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
          timeout: 60000, // 60s for composite operations
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

  // Upload encrypted file to IPFS and record on NEAR blockchain.
  // MCP server handles: key retrieval, encryption, IPFS upload, transaction signing.
  async compositeUpload(
    groupId: string, 
    data: Buffer, 
    filename: string,
    payloadB64?: string,
    sigHex?: string
  ): Promise<CompositeUploadResult> {
    const dataB64 = data.toString('base64');

    // For MCP v3, the server handles signing internally
    const finalPayloadB64 = payloadB64 || '';
    const finalSigHex = sigHex || '';

    return this.callMcpTool<CompositeUploadResult>('composite_upload', {
      group_id: groupId,
      user_id: this.accountId,
      data: dataB64,
      filename,
      payload_b64: finalPayloadB64,
      sig_hex: finalSigHex,
    });
  }

  // Retrieve and decrypt file from IPFS.
  // MCP server handles: key retrieval, IPFS fetch, decryption.
  async compositeRetrieve(
    groupId: string, 
    ipfsHash: string,
    payloadB64?: string,
    sigHex?: string
  ): Promise<CompositeRetrieveResult> {
    if (!ipfsHash.startsWith('Qm')) {
      throw new NovaError(`Invalid CID: ${ipfsHash}`);
    }

    // For MCP, server handles signing
    const finalPayloadB64 = payloadB64 || '';
    const finalSigHex = sigHex || '';

    const result = await this.callMcpTool<{
      decrypted_b64: string;
      file_hash: string;
      fee_breakdown: FeeBreakdown;
      ipfs_hash: string;
      group_id: string;
    }>('composite_retrieve', {
      group_id: groupId,
      ipfs_hash: ipfsHash,
      payload_b64: finalPayloadB64,
      sig_hex: finalSigHex,
    });

    return {
      data: Buffer.from(result.decrypted_b64, 'base64'),
      file_hash: result.file_hash,
      fee_breakdown: result.fee_breakdown,
      ipfs_hash: result.ipfs_hash,
      group_id: result.group_id,
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

  // Utility Method: Compute SHA256 hash of data.
  computeHash(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
}
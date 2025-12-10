// nova/nova-sdk-js/src/index.ts
import { JsonRpcProvider } from '@near-js/providers';
import axios from 'axios';
import * as crypto from 'crypto';
import { Buffer } from 'buffer';

// Infrastructure endpoints (public, immutable)
const DEFAULT_MCP_URL = 'https://nova-mcp.fastmcp.app';
const SHADE_API_URL = 'https://111507d14bb0a0c60d28a61bf6a973ccf4691a36-3000.dstack-prod5.phala.network';
const DEFAULT_RPC_URL = 'https://rpc.testnet.near.org';
const DEFAULT_CONTRACT_ID = 'nova-sdk-5.testnet';

export interface UserIdentifier {
  email?: string;
  walletId?: string;
  accountId?: string;  // NOVA-managed account (e.g., alice-nova.nova-sdk-5.testnet)
  authToken?: string;  // Auth0 token auto-fetched in browser context
}

export interface NovaSdkConfig {
  rpcUrl?: string;
  contractId?: string;
  mcpUrl?: string;
  shadeUrl?: string;
}

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
  email?: string;
  wallet_id?: string;
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
  private userIdentifier: UserIdentifier;
  public readonly contractId: string;
  public readonly mcpUrl: string;
  public readonly shadeUrl: string;
  public readonly rpcUrl: string;

  constructor(userIdOrConfig: UserIdentifier, config?: NovaSdkConfig) {
    this.userIdentifier = userIdOrConfig;
    this.rpcUrl = config?.rpcUrl || DEFAULT_RPC_URL;
    this.contractId = config?.contractId || DEFAULT_CONTRACT_ID;
    this.mcpUrl = config?.mcpUrl || DEFAULT_MCP_URL;
    this.shadeUrl = config?.shadeUrl || SHADE_API_URL;
    this.provider = new JsonRpcProvider({ url: this.rpcUrl });

    // Validate user identifier
    if (!this.userIdentifier.email && !this.userIdentifier.walletId && !this.userIdentifier.accountId) {
      throw new NovaError('User identifier required: provide email, walletId, or accountId');
    }
  }

  // User Context Management
  // Get the NOVA account ID for this user.
  async getAccountId(): Promise<string> {
    if (this.userIdentifier.accountId) {
      return this.userIdentifier.accountId;
    }

    // Resolve from Shade TEE
    const resolved = await this.resolveUserAccount();
    if (!resolved.accountId) {
      throw new NovaError(
        'No NOVA account found. Please create an account at nova-sdk.com first.'
      );
    }
    
    this.userIdentifier.accountId = resolved.accountId;
    return resolved.accountId;
  }

  // Resolve user's NOVA account from Shade TEE using email or wallet_id.
  async resolveUserAccount(): Promise<{ accountId?: string; publicKey?: string; network?: string }> {
    const payload: Record<string, string> = {};
    
    if (this.userIdentifier.walletId) {
      payload.wallet_id = this.userIdentifier.walletId;
    } else if (this.userIdentifier.email) {
      payload.email = this.userIdentifier.email;
      if (this.userIdentifier.authToken) {
        payload.auth_token = this.userIdentifier.authToken;
      }
    } else {
      throw new NovaError('Cannot resolve account: no email or walletId provided');
    }

    try {
      const response = await axios.post(`${this.shadeUrl}/api/user-keys/check`, payload, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.data.exists) {
        return {
          accountId: response.data.account_id,
          publicKey: response.data.public_key,
          network: response.data.network,
        };
      }
      
      return {};
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 404) {
        return {};
      }
      throw new NovaError(`Failed to resolve user account: ${e}`, e as Error);
    }
  }

  // Build HTTP headers for MCP server authentication.
  private getMcpHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.userIdentifier.authToken) {
      headers['Authorization'] = `Bearer ${this.userIdentifier.authToken}`;
    }
    if (this.userIdentifier.email) {
      headers['X-User-Email'] = this.userIdentifier.email;
    }
    if (this.userIdentifier.walletId) {
      headers['X-Wallet-Id'] = this.userIdentifier.walletId;
    }
    if (this.userIdentifier.accountId) {
      headers['X-Account-Id'] = this.userIdentifier.accountId;
    }

    return headers;
  }

  // MCP Tool Invocations - Call an MCP tool directly.
  private async callMcpTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    // Ensure we have account ID resolved
    if (!this.userIdentifier.accountId) {
      await this.getAccountId();
    }

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
    const accountId = await this.getAccountId();
    const dataB64 = data.toString('base64');

    // If payload/sig not provided, generate them (requires local signing capability)
    let finalPayloadB64 = payloadB64;
    let finalSigHex = sigHex;

    if (!finalPayloadB64 || !finalSigHex) {
      // For MCP v3, the server can handle signing internally
      // We pass empty strings and let MCP use get_user_signer()
      finalPayloadB64 = '';
      finalSigHex = '';
    }

    return this.callMcpTool<CompositeUploadResult>('composite_upload', {
      group_id: groupId,
      user_id: accountId,
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

    // For MCP v3, server handles signing
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
    const id = accountId || await this.getAccountId();
    try {
      const accountView = await this.provider.viewAccount(id);
      return accountView.amount.toString();
    } catch (e) {
      throw new NovaError(`Balance query error: ${e}`, e as Error);
    }
  }

  async isAuthorized(groupId: string, userId?: string): Promise<boolean> {
    const id = userId || await this.getAccountId();
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
    const id = userId || await this.getAccountId();
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
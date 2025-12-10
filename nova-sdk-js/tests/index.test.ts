// nova/nova-sdk-js/tests/index.test.ts
import { NovaSdk, NovaError, UserIdentifier, NovaSdkConfig } from '../src/index';
import axios from 'axios';

jest.mock('axios');

const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockAxiosIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockAxiosIsAxiosError.mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NovaSdk v3', () => {
  const defaultConfig: NovaSdkConfig = {
    rpcUrl: 'https://rpc.testnet.near.org',
    contractId: 'nova-sdk-5.testnet',
  };

  describe('Constructor', () => {
    test('initializes with email identifier', () => {
      const sdk = new NovaSdk({ email: 'user@example.com' });
      expect(sdk.contractId).toBe('nova-sdk-5.testnet');
      expect(sdk.mcpUrl).toBe('https://nova-mcp.fastmcp.app');
      expect(sdk.shadeUrl).toBe('https://111507d14bb0a0c60d28a61bf6a973ccf4691a36-3000.dstack-prod5.phala.network');
    });

    test('initializes with walletId identifier', () => {
      const sdk = new NovaSdk({ walletId: 'alice.near' });
      expect(sdk.contractId).toBe('nova-sdk-5.testnet');
    });

    test('initializes with accountId identifier', () => {
      const sdk = new NovaSdk({ accountId: 'alice-nova.nova-sdk-5.testnet' });
      expect(sdk.contractId).toBe('nova-sdk-5.testnet');
    });

    test('accepts custom config', () => {
      const sdk = new NovaSdk(
        { email: 'user@example.com' },
        {
          rpcUrl: 'https://rpc.mainnet.near.org',
          contractId: 'nova-sdk.near',
          mcpUrl: 'https://custom-mcp.example.com',
          shadeUrl: 'https://custom-shade.example.com',
        }
      );
      expect(sdk.rpcUrl).toBe('https://rpc.mainnet.near.org');
      expect(sdk.contractId).toBe('nova-sdk.near');
      expect(sdk.mcpUrl).toBe('https://custom-mcp.example.com');
      expect(sdk.shadeUrl).toBe('https://custom-shade.example.com');
    });

    test('throws without user identifier', () => {
      expect(() => new NovaSdk({} as UserIdentifier)).toThrow(NovaError);
      expect(() => new NovaSdk({} as UserIdentifier)).toThrow('User identifier required');
    });
  });

  describe('User Context Management', () => {
    test('getAccountId returns cached accountId', async () => {
      const sdk = new NovaSdk({ accountId: 'alice-nova.nova-sdk-5.testnet' });
      const accountId = await sdk.getAccountId();
      expect(accountId).toBe('alice-nova.nova-sdk-5.testnet');
      expect(mockAxiosPost).not.toHaveBeenCalled();
    });

    test('getAccountId resolves from Shade for wallet user', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          exists: true,
          account_id: 'alice-nova.nova-sdk-5.testnet',
          public_key: 'ed25519:ABC123',
          network: 'testnet',
        },
      });

      const sdk = new NovaSdk({ walletId: 'alice.near' });
      const accountId = await sdk.getAccountId();

      expect(accountId).toBe('alice-nova.nova-sdk-5.testnet');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://111507d14bb0a0c60d28a61bf6a973ccf4691a36-3000.dstack-prod5.phala.network/api/user-keys/check',
        { wallet_id: 'alice.near' },
        expect.any(Object)
      );
    });

    test('getAccountId resolves from Shade for email user', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          exists: true,
          account_id: 'bob-nova.nova-sdk-5.testnet',
          public_key: 'ed25519:XYZ789',
          network: 'testnet',
        },
      });

      const sdk = new NovaSdk({ email: 'bob@example.com', authToken: 'jwt-token' });
      const accountId = await sdk.getAccountId();

      expect(accountId).toBe('bob-nova.nova-sdk-5.testnet');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://111507d14bb0a0c60d28a61bf6a973ccf4691a36-3000.dstack-prod5.phala.network/api/user-keys/check',
        { email: 'bob@example.com', auth_token: 'jwt-token' },
        expect.any(Object)
      );
    });

    test('getAccountId throws when no account found', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { exists: false },
      });

      const sdk = new NovaSdk({ walletId: 'newuser.near' });
      await expect(sdk.getAccountId()).rejects.toThrow('No NOVA account found');
    });

    test('resolveUserAccount handles 404 gracefully', async () => {
      mockAxiosIsAxiosError.mockReturnValue(true);
      mockAxiosPost.mockRejectedValueOnce({
        response: { status: 404 },
        isAxiosError: true,
      });

      const sdk = new NovaSdk({ walletId: 'unknown.near' });
      const result = await sdk.resolveUserAccount();

      expect(result).toEqual({});
    });
  });

  describe('MCP Tool Invocations', () => {
    test('authStatus calls MCP correctly', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          authenticated: true,
          email: 'user@example.com',
          near_account_id: 'user-nova.nova-sdk-5.testnet',
          authorized_for_group: true,
        },
      });

      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet', email: 'user@example.com' });
      const result = await sdk.authStatus('my-group');

      expect(result.authenticated).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/auth_status',
        { group_id: 'my-group' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Account-Id': 'user-nova.nova-sdk-5.testnet',
            'X-User-Email': 'user@example.com',
          }),
        })
      );
    });

    test('registerGroup calls MCP correctly', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Group 'my-team' registered successfully" },
      });

      const sdk = new NovaSdk({ accountId: 'owner-nova.nova-sdk-5.testnet' });
      const result = await sdk.registerGroup('my-team');

      expect(result).toBe("Group 'my-team' registered successfully");
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/register_group',
        { group_id: 'my-team' },
        expect.any(Object)
      );
    });

    test('addGroupMember calls MCP correctly', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Added bob-nova.nova-sdk-5.testnet to group 'my-team'" },
      });

      const sdk = new NovaSdk({ accountId: 'owner-nova.nova-sdk-5.testnet' });
      const result = await sdk.addGroupMember('my-team', 'bob-nova.nova-sdk-5.testnet');

      expect(result).toContain('Added bob-nova');
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/add_group_member',
        { group_id: 'my-team', member_id: 'bob-nova.nova-sdk-5.testnet' },
        expect.any(Object)
      );
    });

    test('revokeGroupMember calls MCP correctly', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Revoked bob-nova.nova-sdk-5.testnet from group 'my-team'" },
      });

      const sdk = new NovaSdk({ accountId: 'owner-nova.nova-sdk-5.testnet' });
      const result = await sdk.revokeGroupMember('my-team', 'bob-nova.nova-sdk-5.testnet');

      expect(result).toContain('Revoked bob-nova');
    });
  });

  describe('Composite Operations', () => {
    test('compositeUpload calls MCP with correct params', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          cid: 'QmXyz123456789abcdefghijklmnopqrstuvwxyz1234',
          trans_id: 'tx-12345',
          file_hash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
          fee_breakdown: { claim: 0.001, record: 0.002, total: 0.003 },
        },
      });

      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });
      const data = Buffer.from('Hello, NOVA!');
      const result = await sdk.compositeUpload('my-group', data, 'hello.txt');

      expect(result.cid).toBe('QmXyz123456789abcdefghijklmnopqrstuvwxyz1234');
      expect(result.trans_id).toBe('tx-12345');
      expect(result.fee_breakdown.total).toBe(0.003);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/composite_upload',
        {
          group_id: 'my-group',
          user_id: 'user-nova.nova-sdk-5.testnet',
          data: data.toString('base64'),
          filename: 'hello.txt',
          payload_b64: '',
          sig_hex: '',
        },
        expect.any(Object)
      );
    });

    test('compositeRetrieve calls MCP and decodes response', async () => {
      const originalData = 'Hello, NOVA!';
      const dataB64 = Buffer.from(originalData).toString('base64');

      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          decrypted_b64: dataB64,
          file_hash: 'somehash',
          fee_breakdown: { claim: 0.001, total: 0.001 },
          ipfs_hash: 'QmXyz123456789abcdefghijklmnopqrstuvwxyz1234',
          group_id: 'my-group',
        },
      });

      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });
      const result = await sdk.compositeRetrieve('my-group', 'QmXyz123456789abcdefghijklmnopqrstuvwxyz1234');

      expect(result.data.toString()).toBe(originalData);
      expect(result.ipfs_hash).toBe('QmXyz123456789abcdefghijklmnopqrstuvwxyz1234');
      expect(result.group_id).toBe('my-group');
    });

    test('compositeRetrieve validates CID format', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      await expect(sdk.compositeRetrieve('my-group', 'invalid_cid')).rejects.toThrow('Invalid CID');
    });
  });

  describe('Read-Only Contract Queries', () => {
    test('getBalance queries RPC', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      // Mock provider.viewAccount
      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'viewAccount').mockResolvedValueOnce({
        amount: '1000000000000000000000000',
      });

      const balance = await sdk.getBalance();
      expect(balance).toBe('1000000000000000000000000');
    });

    test('isAuthorized queries contract', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('true'),
      });

      const authorized = await sdk.isAuthorized('my-group');
      expect(authorized).toBe(true);
    });

    test('getGroupOwner queries contract', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('"owner-nova.nova-sdk-5.testnet"'),
      });

      const owner = await sdk.getGroupOwner('my-group');
      expect(owner).toBe('owner-nova.nova-sdk-5.testnet');
    });

    test('getGroupChecksum queries contract', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('"abc123checksum"'),
      });

      const checksum = await sdk.getGroupChecksum('my-group');
      expect(checksum).toBe('abc123checksum');
    });

    test('estimateFee queries contract', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('1000000000000000000000'),
      });

      const fee = await sdk.estimateFee('claim_token');
      expect(fee).toBe(1000000000000000000000n);
    });

    test('getTransactionsForGroup queries contract', async () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from(JSON.stringify([
          { group_id: 'my-group', user_id: 'user-nova.nova-sdk-5.testnet', file_hash: 'abc', ipfs_hash: 'Qm123' },
        ])),
      });

      const txs = await sdk.getTransactionsForGroup('my-group');
      expect(Array.isArray(txs)).toBe(true);
      expect(txs[0].group_id).toBe('my-group');
    });
  });

  describe('Utility Methods', () => {
    test('computeHash returns SHA256 hex', () => {
      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });
      const hash = sdk.computeHash(Buffer.from('test data'));

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).toBe('916f0027a575074ce72a331777c3478d6513f786a591bd892da1a577bf2335f9');
    });
  });

  describe('Error Handling', () => {
    test('NovaError preserves cause', () => {
      const cause = new Error('Original error');
      const novaError = new NovaError('Wrapper error', cause);

      expect(novaError.message).toBe('Wrapper error');
      expect(novaError.cause).toBe(cause);
      expect(novaError.name).toBe('NovaError');
    });

    test('MCP errors are wrapped in NovaError', async () => {
      mockAxiosIsAxiosError.mockReturnValue(true);
      mockAxiosPost.mockRejectedValueOnce({
        response: { data: { error: 'Unauthorized' } },
        message: 'Request failed',
        isAxiosError: true,
      });

      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });

      await expect(sdk.registerGroup('my-group')).rejects.toThrow(NovaError);
      await expect(sdk.registerGroup('my-group')).rejects.toThrow(/MCP tool.*failed/);
    });

    test('Shade errors are wrapped in NovaError', async () => {
      mockAxiosPost.mockRejectedValueOnce(new Error('Network error'));

      const sdk = new NovaSdk({ walletId: 'alice.near' });

      await expect(sdk.resolveUserAccount()).rejects.toThrow(NovaError);
      await expect(sdk.resolveUserAccount()).rejects.toThrow('Failed to resolve user account');
    });
  });

  describe('Header Construction', () => {
    test('getMcpHeaders includes all identifiers', async () => {
      mockAxiosPost.mockResolvedValueOnce({ status: 200, data: {} });

      const sdk = new NovaSdk({
        email: 'user@example.com',
        walletId: 'user.near',
        accountId: 'user-nova.nova-sdk-5.testnet',
        authToken: 'jwt-token-123',
      });

      await sdk.authStatus();

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer jwt-token-123',
            'X-User-Email': 'user@example.com',
            'X-Wallet-Id': 'user.near',
            'X-Account-Id': 'user-nova.nova-sdk-5.testnet',
          },
        })
      );
    });

    test('getMcpHeaders omits undefined values', async () => {
      mockAxiosPost.mockResolvedValueOnce({ status: 200, data: {} });

      const sdk = new NovaSdk({ accountId: 'user-nova.nova-sdk-5.testnet' });
      await sdk.authStatus();

      const call = mockAxiosPost.mock.calls[0];
      const headers = call[2]?.headers;

      expect(headers).not.toHaveProperty('Authorization');
      expect(headers).not.toHaveProperty('X-User-Email');
      expect(headers).not.toHaveProperty('X-Wallet-Id');
      expect(headers).toHaveProperty('X-Account-Id');
    });
  });

  describe('Integration Tests', () => {
    const shouldSkip = !process.env.TEST_NOVA_ACCOUNT_ID;

    test('real getBalance query', async () => {
      if (shouldSkip) {
        console.log('Skipping: TEST_NOVA_ACCOUNT_ID required');
        return;
      }

      const sdk = new NovaSdk({ accountId: process.env.TEST_NOVA_ACCOUNT_ID! });
      const balance = await sdk.getBalance();

      expect(balance).toMatch(/^\d+$/);
      expect(BigInt(balance)).toBeGreaterThanOrEqual(0n);
    }, 10000);

    test('real estimateFee query', async () => {
      if (shouldSkip) {
        console.log('Skipping: TEST_NOVA_ACCOUNT_ID required');
        return;
      }

      const sdk = new NovaSdk({ accountId: process.env.TEST_NOVA_ACCOUNT_ID! });
      const fee = await sdk.estimateFee('claim_token');

      expect(fee).toBeGreaterThan(0n);
    }, 10000);

    test('real isAuthorized query', async () => {
      if (shouldSkip) {
        console.log('Skipping: TEST_NOVA_ACCOUNT_ID required');
        return;
      }

      const sdk = new NovaSdk({ accountId: process.env.TEST_NOVA_ACCOUNT_ID! });
      const authorized = await sdk.isAuthorized('test-group-1');

      expect(typeof authorized).toBe('boolean');
    }, 10000);
  });
});
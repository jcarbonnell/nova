// nova/nova-sdk-js/tests/index.test.ts
import { NovaSdk, NovaError } from '../src/index';
import axios from 'axios';

jest.mock('axios');

const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockAxiosIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

// Mock session token (in real usage, get from nova-sdk.com)
const mockSessionToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Utbm92YS5ub3ZhLXNkay01LnRlc3RuZXQiLCJ0eXBlIjoibm92YV9zZXNzaW9uIn0.mock';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  
  mockAxiosIsAxiosError.mockImplementation((error: unknown) => {
    return error !== null && typeof error === 'object' && 'isAxiosError' in error;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NovaSdk v3', () => {
  const testAccountId = 'alice-nova.nova-sdk-5.testnet';

  describe('Constructor', () => {
    test('initializes with accountId and sessionToken', () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      expect(sdk.accountId).toBe(testAccountId);
      expect(sdk.contractId).toBe('nova-sdk-5.testnet');
      expect(sdk.mcpUrl).toBe('https://nova-mcp.fastmcp.app');
      expect(sdk.rpcUrl).toBe('https://rpc.testnet.near.org');
    });

    test('accepts custom config', () => {
      const sdk = new NovaSdk(testAccountId, {
        sessionToken: mockSessionToken,
        rpcUrl: 'https://rpc.mainnet.near.org',
        contractId: 'nova-sdk.near',
        mcpUrl: 'https://custom-mcp.example.com',
      });
      expect(sdk.rpcUrl).toBe('https://rpc.mainnet.near.org');
      expect(sdk.contractId).toBe('nova-sdk.near');
      expect(sdk.mcpUrl).toBe('https://custom-mcp.example.com');
    });

    test('throws without accountId', () => {
      expect(() => new NovaSdk('', { sessionToken: mockSessionToken })).toThrow('accountId required');
      expect(() => new NovaSdk(null as unknown as string, { sessionToken: mockSessionToken })).toThrow('accountId required');
    });

    test('throws without sessionToken', () => {
      expect(() => new NovaSdk(testAccountId, {} as any)).toThrow('sessionToken required');
      expect(() => new NovaSdk(testAccountId, { sessionToken: '' } as any)).toThrow('sessionToken required');
      expect(() => new NovaSdk(testAccountId, undefined as any)).toThrow('sessionToken required');
    });
  });

  describe('MCP Tool Calls', () => {
    test('authStatus calls MCP with Authorization header', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          authenticated: true,
          near_account_id: testAccountId,
          authorized_for_group: true,
        },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const result = await sdk.authStatus('my-group');

      expect(result.authenticated).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/auth_status',
        { group_id: 'my-group' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockSessionToken}`,
            'X-Account-Id': testAccountId,
          }),
        })
      );
    });

    test('registerGroup calls MCP with auth headers', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Group 'test-group' registered successfully" },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const result = await sdk.registerGroup('test-group');

      expect(result).toBe("Group 'test-group' registered successfully");
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/register_group',
        { group_id: 'test-group' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockSessionToken}`,
          }),
        })
      );
    });

    test('addGroupMember calls MCP add_group_member tool', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Added bob-nova.nova-sdk-5.testnet to group 'test-group'" },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const result = await sdk.addGroupMember('test-group', 'bob-nova.nova-sdk-5.testnet');

      expect(result).toContain('Added bob-nova');
    });

    test('revokeGroupMember calls MCP revoke_group_member tool', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Revoked bob-nova.nova-sdk-5.testnet from group 'test-group'" },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const result = await sdk.revokeGroupMember('test-group', 'bob-nova.nova-sdk-5.testnet');

      expect(result).toContain('Revoked bob-nova');
    });
  });

  describe('Composite Operations', () => {
    test('compositeUpload calls MCP with base64 data and auth', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          cid: 'QmTestCid123456789012345678901234567890123',
          trans_id: 'tx_abc123',
          file_hash: 'a'.repeat(64),
          fee_breakdown: { claim: 0.001, record: 0.002, total: 0.003 },
        },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const testData = Buffer.from('Hello NOVA!');
      const result = await sdk.compositeUpload('test-group', testData, 'hello.txt');

      expect(result.cid).toBe('QmTestCid123456789012345678901234567890123');
      expect(result.trans_id).toBe('tx_abc123');
      expect(result.fee_breakdown.total).toBe(0.003);

      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://nova-mcp.fastmcp.app/tools/composite_upload',
        expect.objectContaining({
          group_id: 'test-group',
          user_id: testAccountId,
          data: testData.toString('base64'),
          filename: 'hello.txt',
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockSessionToken}`,
          }),
        })
      );
    });

    test('compositeRetrieve returns decrypted Buffer', async () => {
      const originalData = 'Hello NOVA!';
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          decrypted_b64: Buffer.from(originalData).toString('base64'),
          file_hash: 'a'.repeat(64),
          fee_breakdown: { claim: 0.001, total: 0.001 },
          ipfs_hash: 'QmTestCid123456789012345678901234567890123',
          group_id: 'test-group',
        },
      });

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const result = await sdk.compositeRetrieve(
        'test-group',
        'QmTestCid123456789012345678901234567890123'
      );

      expect(result.data.toString()).toBe(originalData);
    });

    test('compositeRetrieve validates CID format', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      await expect(
        sdk.compositeRetrieve('test-group', 'invalid_cid')
      ).rejects.toThrow('Invalid CID: invalid_cid');
    });
  });

  describe('Read-Only Contract Queries', () => {
    test('getBalance queries NEAR RPC (no auth needed)', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'viewAccount').mockResolvedValueOnce({
        amount: '1000000000000000000000000',
      });

      const balance = await sdk.getBalance();
      expect(balance).toBe('1000000000000000000000000');
    });

    test('isAuthorized queries contract', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('true'),
      });

      const authorized = await sdk.isAuthorized('test-group');
      expect(authorized).toBe(true);
    });

    test('getGroupOwner returns owner account', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('"owner.nova-sdk-5.testnet"'),
      });

      const owner = await sdk.getGroupOwner('test-group');
      expect(owner).toBe('owner.nova-sdk-5.testnet');
    });

    test('estimateFee returns bigint', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('1000000000000000000000'),
      });

      const fee = await sdk.estimateFee('claim_token');
      expect(fee).toBe(1000000000000000000000n);
    });

    test('getTransactionsForGroup returns array', async () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from(JSON.stringify([
          {
            group_id: 'test-group',
            user_id: testAccountId,
            file_hash: 'abc123',
            ipfs_hash: 'QmTest',
          },
        ])),
      });

      const transactions = await sdk.getTransactionsForGroup('test-group');
      expect(Array.isArray(transactions)).toBe(true);
      expect(transactions[0].group_id).toBe('test-group');
    });
  });

  describe('Utility Methods', () => {
    test('computeHash returns SHA256 hex string', () => {
      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });
      const data = Buffer.from('test data');
      const hash = sdk.computeHash(data);

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

    test('MCP 401 error indicates auth failure', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { 
          status: 401,
          data: { error: 'Session token expired' } 
        },
        message: 'Request failed with status 401',
      };
      mockAxiosPost.mockRejectedValueOnce(axiosError);

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      await expect(sdk.registerGroup('test')).rejects.toThrow(NovaError);
      await expect(sdk.registerGroup('test')).rejects.toThrow(/Session token expired/);
    });

    test('MCP 403 error indicates account mismatch', async () => {
      const axiosError = {
        isAxiosError: true,
        response: { 
          status: 403,
          data: { error: 'Account ID mismatch' } 
        },
        message: 'Request failed with status 403',
      };
      mockAxiosPost.mockRejectedValueOnce(axiosError);
      mockAxiosIsAxiosError.mockReturnValueOnce(true);

      const sdk = new NovaSdk(testAccountId, { sessionToken: mockSessionToken });

      await expect(sdk.registerGroup('test')).rejects.toThrow(NovaError);
    });
  });
});
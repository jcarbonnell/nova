import { NovaSdk, NovaError } from '../src/index';
import axios from 'axios';

jest.mock('axios');

const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockAxiosIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

// Mock session token (in real usage, get from nova-sdk.com)
const mockApiKey = 'nova_sk_mockapikey1234567890123456789012345678901';
const mockSessionToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Uubm92YS1zZGsubmVhciIsInR5cGUiOiJub3ZhX3Nlc3Npb24ifQ.mock';

beforeEach(() => {
  jest.resetAllMocks(); // clears both call history AND the mockResolvedValueOnce queue
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  mockAxiosIsAxiosError.mockImplementation((error: unknown) => {
    return error !== null && typeof error === 'object' && 'isAxiosError' in error;
  });

  // Mock session token exchange — consumed as first axios call in each test
  mockAxiosPost.mockResolvedValueOnce({
    status: 200,
    data: { token: mockSessionToken, expires_in: '24h', account_id: 'alice.nova-sdk.near' },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NovaSdk v3', () => {
  const testAccountId = 'alice.nova-sdk.near';

  describe('Constructor', () => {
    test('initializes with accountId and sessionToken', () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey }
);
      expect(sdk.accountId).toBe(testAccountId);
      expect(sdk.contractId).toBe('nova-sdk.near');
      expect(sdk.mcpUrl).toBe('https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network');
      expect(sdk.rpcUrl).toBe('https://rpc.mainnet.near.org');
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
      expect(() => new NovaSdk('', { apiKey: mockApiKey }
)).toThrow('accountId required');
      expect(() => new NovaSdk(null as unknown as string, { apiKey: mockApiKey }
)).toThrow('accountId required');
    });

    test('throws without apiKey at first API call', async () => {
      // apiKey validation is lazy — constructor succeeds, throws on first call
      // beforeEach session token mock goes unused here; resetAllMocks cleans it up before next test
      const sdk = new NovaSdk(testAccountId);
      await expect(sdk.authStatus()).rejects.toThrow('API key required');
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

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const result = await sdk.authStatus('my-group');

      expect(result.authenticated).toBe(true);
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network/tools/auth_status',
        { group_id: 'my-group' },
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': `Bearer ${mockSessionToken}`,
            'x-account-id': testAccountId,
            'x-wallet-id': testAccountId,
          }),
        })
      );
    });

    test('registerGroup calls MCP with auth headers', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Group 'test-group' registered successfully" },
      });

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const result = await sdk.registerGroup('test-group');

      expect(result).toBe("Group 'test-group' registered successfully");
      expect(mockAxiosPost).toHaveBeenCalledWith(
        'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network/tools/register_group',
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
        data: { message: "Added bob-nova.nova-sdk.near to group 'test-group'" },
      });

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const result = await sdk.addGroupMember('test-group', 'bob-nova.nova-sdk.near');

      expect(result).toContain('Added bob-nova');
    });

    test('revokeGroupMember calls MCP revoke_group_member tool', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { message: "Revoked bob-nova.nova-sdk.near from group 'test-group'" },
      });

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const result = await sdk.revokeGroupMember('test-group', 'bob-nova.nova-sdk.near');

      expect(result).toContain('Revoked bob-nova');
    });
  });

  describe('Composite Operations', () => {
    test('upload calls MCP with base64 data and auth', async () => {
      // Mock prepare_upload (first call)
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          upload_id: 'test-upload-123',
          key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',  // Mock 32-byte key b64
          group_id: 'test-group',
          filename: 'hello.txt',
        },
      });

      // Mock finalize-upload (second call – HTTP endpoint)
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          cid: 'QmTestCid123456789012345678901234567890123',
          trans_id: 'tx_abc123',
          file_hash: 'a'.repeat(64),
        },
      });

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const testData = Buffer.from('Hello NOVA!');
      const result = await sdk.upload('test-group', testData, 'hello.txt');

      expect(result.cid).toBe('QmTestCid123456789012345678901234567890123');
      expect(result.trans_id).toBe('tx_abc123');
    });

    test('retrieve returns decrypted Buffer', async () => {
      const originalData = 'Hello NOVA!';
      const mockKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

      // Generate a real AES-256-GCM encrypted blob so SubtleCrypto can decrypt it
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('crypto');
      const keyBytes = Buffer.from(mockKey, 'base64');
      const iv = Buffer.alloc(12, 0); // deterministic IV for reproducibility
      const cipher = nodeCrypto.createCipheriv('aes-256-gcm', keyBytes, iv);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(originalData)),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      // Format: IV (12) + ciphertext + authTag (16) — matches encryptData output
      const encryptedB64 = Buffer.concat([iv, encrypted, authTag]).toString('base64');

      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: {
          key: mockKey,
          encrypted_b64: encryptedB64,
          ipfs_hash: 'QmTestCid123456789012345678901234567890123',
          group_id: 'test-group',
        },
      });

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
      const result = await sdk.retrieve(
        'test-group',
        'QmTestCid123456789012345678901234567890123'
      );

      expect(result.data.toString()).toBe(originalData);
    });

    test('retrieve validates CID format', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      await expect(
        sdk.retrieve('test-group', 'invalid_cid')
      ).rejects.toThrow('Invalid CID: invalid_cid');
    });
  });

  describe('Read-Only Contract Queries', () => {
    test('getBalance queries NEAR RPC (no auth needed)', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'viewAccount').mockResolvedValueOnce({
        amount: '1000000000000000000000000',
      });

      const balance = await sdk.getBalance();
      expect(balance).toBe('1000000000000000000000000');
    });

    test('isAuthorized queries contract', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('true'),
      });

      const authorized = await sdk.isAuthorized('test-group');
      expect(authorized).toBe(true);
    });

    test('getGroupOwner returns owner account', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('"owner.nova-sdk.near"'),
      });

      const owner = await sdk.getGroupOwner('test-group');
      expect(owner).toBe('owner.nova-sdk.near');
    });

    test('estimateFee returns bigint', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      const mockProvider = (sdk as any).provider;
      jest.spyOn(mockProvider, 'query').mockResolvedValueOnce({
        result: Buffer.from('1000000000000000000000'),
      });

      const fee = await sdk.estimateFee('claim_token');
      expect(fee).toBe(1000000000000000000000n);
    });

    test('getTransactionsForGroup returns array', async () => {
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

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
      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
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

      // Queue error for both registerGroup calls (each call hits axios once for the tool)
      mockAxiosPost.mockRejectedValueOnce(axiosError);
      mockAxiosPost.mockRejectedValueOnce(axiosError);
      mockAxiosIsAxiosError.mockReturnValue(true);

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
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

      const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });

      await expect(
        sdk.registerGroup('test')
      ).rejects.toThrow(NovaError);
    });
  });
});
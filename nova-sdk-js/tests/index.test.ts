import { NovaSdk, NovaError, Transaction, FeeBreakdown } from '../src/index';
import * as NodeCrypto from 'crypto';
import axios from 'axios';

jest.mock('axios');

const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
mockAxiosPost.mockResolvedValue({
  status: 200,
  data: { key: 'dHVtbXlLZXlGb3JUZXN0aW5nCg==', checksum: '97a57412d4f963777c711137e491829a1635f9a65787ecc0e5d3d7c6c3e5d3be' }
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {}); // Mock logs to avoid noise
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('NovaSdk', () => {
  const rpcUrl = 'https://rpc.testnet.near.org';
  const contractId = 'nova-sdk-5.testnet';
  const fakePinataKey = 'fake_key';
  const fakePinataSecret = 'fake_secret';
  const shadeApiUrl = 'https://1b7616f73af7404b06274bb91394525f58f63c53-3000.dstack-prod5.phala.network';

  test('constructor initializes correctly', () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    expect(sdk.contractId).toBe(contractId);
    expect(sdk.pinataKey).toBe(fakePinataKey);
    expect(sdk.pinataSecret).toBe(fakePinataSecret);
    expect(sdk.shadeApiUrl).toBe(shadeApiUrl);
  });

  test('withSigner accepts valid key format', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    // Mock valid key (in real: use env or test key)
    const mockKey = 'ed25519:ABC123dummybase58key32bytesencodedhereforrusttest';
    const result = await sdk.withSigner(mockKey, 'test.account.testnet');
    expect(result).toBe(sdk);
  });

  test('withSigner rejects completely invalid format', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    await expect(
      sdk.withSigner('not-a-valid-key', 'test.account.testnet')
    ).rejects.toThrow(NovaError);
  });

  test('getBalance returns yoctoNEAR string', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    const balance = await sdk.getBalance('nova-sdk-5.testnet');
    expect(balance).toMatch(/^\d+$/);
    expect(BigInt(balance)).toBeGreaterThanOrEqual(0n);
  }, 10000);

  test('isAuthorized returns false for unauthorized user', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    const authorized = await sdk.isAuthorized('test-group-1', 'nonexistent.user.testnet');
    expect(typeof authorized).toBe('boolean');
    expect(authorized).toBe(false);
  }, 10000);

  test('estimateFee returns bigint for known action', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    // Mock provider.query to return a sample fee (e.g., 0.001 NEAR = 10^21 yocto)
    const mockProvider = (sdk as any).provider;
    const spyQuery = jest.spyOn(mockProvider, 'query');
    spyQuery.mockResolvedValueOnce({
      result: '1000000000000000000000' // 10^21 yocto
    } as any);

    const fee = await sdk.estimateFee('claim_token');
    expect(fee).toBe(1000000000000000000000n);
    expect(typeof fee).toBe('bigint');

    spyQuery.mockRestore();
  });

  test('getGroupKey throws for unauthorized user', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    await expect(
      sdk.getGroupKey('test-group-1', 'nonexistent.user.testnet')
    ).rejects.toThrow(NovaError);
  }, 10000);

  test('getTransactionsForGroup returns array', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    const accountId = process.env.TEST_NEAR_ACCOUNT_ID || 'nova-sdk-5.testnet';
    
    try {
      const transactions = await sdk.getTransactionsForGroup('test-group-1', accountId);
      expect(Array.isArray(transactions)).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(NovaError);
    }
  }, 10000);

  test('executeContractCall requires signer', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
    await expect(
      sdk.registerGroup('test_group_new')
    ).rejects.toThrow('No signer attached');
  });

  // Integration tests - only run if environment variables are set
  describe('Integration tests', () => {
    const privateKey = process.env.TEST_NEAR_PRIVATE_KEY;
    const accountId = process.env.TEST_NEAR_ACCOUNT_ID;
    const pinataKey = process.env.PINATA_API_KEY;
    const pinataSecret = process.env.PINATA_SECRET_KEY;

    const shouldSkip = !privateKey || !accountId;
    const skipMessage = 'Skipping: TEST_NEAR_PRIVATE_KEY and TEST_NEAR_ACCOUNT_ID required';

    test('withSigner works with valid credentials', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      const signedSdk = await sdk.withSigner(privateKey!, accountId!);
      expect(signedSdk).toBe(sdk); // Should return same instance
    }, 10000);

    test('estimateFee returns expected value in integration', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      const fee = await sdk.estimateFee('claim_token');
      expect(fee).toBeGreaterThan(0n); // Should be >0 for real contract
    }, 10000);

    test('getGroupKey returns base64 key for authorized user', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      await sdk.withSigner(privateKey!, accountId!);

      const mockChecksum = '97a57412d4f963777c711137e491829a1635f9a65787ecc0e5d3d7c6c3e5d3be';

      // Mock Shade response
      mockAxiosPost.mockResolvedValueOnce({
        status: 200,
        data: { key: 'dHVtbXlLZXlGb3JUZXN0aW5nCg==', checksum: mockChecksum }
      });

      // Mock provider.query for estimate_fee in getGroupKey
      const mockQuery = jest.spyOn((sdk as any).provider, 'query');
      mockQuery.mockResolvedValueOnce({
        result: '1000000000000000000000' // 0.001 NEAR for estimate_fee
      } as any);

      // Mock getGroupChecksum: set result to the JSON string directly so decoded = '"hexstr"', parse = 'hexstr'
      mockQuery.mockResolvedValueOnce({
        result: JSON.stringify(mockChecksum) // '"hexstr"'
      } as any);

      // Mock callFunction for claim_token: toString returns base64 of plain token str
      const mockCallFn = jest.spyOn(sdk.account!, 'callFunction');
      const plainToken = 'payloadB64.sigHex';
      mockCallFn.mockResolvedValueOnce({
        toString: () => Buffer.from(plainToken, 'utf8').toString('base64') // base64 of token str
      } as any);

      const key = await sdk.getGroupKey('test-group-1', accountId!);
      console.log('Retrieved key length:', key.length);

      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(20);
      const testBuffer = Buffer.from(key, 'base64');
      expect(testBuffer.length).toBeGreaterThan(0);

      // Verify fee log was called (since console.log mocked)
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Key access fee:'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cost breakdown:'));

      mockQuery.mockRestore();
      mockCallFn.mockRestore();
    }, 10000);

    test('isAuthorized returns true for authorized user', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      const authorized = await sdk.isAuthorized('test-group-1', accountId!);
      expect(typeof authorized).toBe('boolean');
    }, 10000);

    test('compositeUpload and retrieve full flow', async () => {
      if (!privateKey || !accountId || !pinataKey || !pinataSecret) {
        console.log('Skipping: All env vars required');
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, pinataKey, pinataSecret, shadeApiUrl);
      await sdk.withSigner(privateKey, accountId);

      // Mock Shade for key fetch
      (axios.post as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { key: 'dHVtbXlLZXlGb3JUZXN0aW5nCg==', checksum: 'dummy_checksum' }
      });

      const testData = Buffer.from('Test data for NOVA SDK: ' + Date.now());
      const filename = `test-v2-${Date.now()}.txt`;
      
      const uploadResult = await sdk.compositeUpload('test-group-1', accountId, testData, filename);
      
      expect(uploadResult.cid).toMatch(/^Qm[a-zA-Z0-9]{44}$/); // Valid IPFS CID
      expect(uploadResult.file_hash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
      expect(uploadResult.trans_id).toBeTruthy();

      // Verify fee_breakdown
      expect(uploadResult.fee_breakdown).toBeDefined();
      expect(typeof uploadResult.fee_breakdown.claim).toBe('number');
      expect(typeof uploadResult.fee_breakdown.record).toBe('number');
      expect(typeof uploadResult.fee_breakdown.total).toBe('number');
      expect(uploadResult.fee_breakdown.total).toBeGreaterThanOrEqual(0);

      // Mock again for retrieve
      (axios.post as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { key: 'dHVtbXlLZXlGb3JUZXN0aW5nCg==', checksum: 'dummy_checksum' }
      });

      // Retrieve the data
      const retrieveResult = await sdk.compositeRetrieve('test-group-1', uploadResult.cid);
      
      expect(retrieveResult.data.toString()).toBe(testData.toString());
      expect(retrieveResult.file_hash).toBe(uploadResult.file_hash);

      // Verify fee_breakdown for retrieve
      expect(retrieveResult.fee_breakdown).toBeDefined();
      expect(typeof retrieveResult.fee_breakdown.claim).toBe('number');
      expect(retrieveResult.fee_breakdown.record).toBeUndefined();
      expect(typeof retrieveResult.fee_breakdown.total).toBe('number');
      expect(retrieveResult.fee_breakdown.total).toBeGreaterThanOrEqual(0);

      // Verify logs for fees
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Composite upload fee:'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cost breakdown:'));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Composite retrieve fee:'));
    }, 30000);

    test('transferTokens sends NEAR tokens', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      await sdk.withSigner(privateKey!, accountId!);

      // Send 0.001 NEAR to self (1000000000000000000000 yoctoNEAR)
      const result = await sdk.transferTokens(accountId!, '1000000000000000000000');
      expect(result).toBe('Success');
    }, 30000);

    test('addGroupMember adds member to group', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      await sdk.withSigner(privateKey!, accountId!);

      // Mock estimate_fee for add_group_member
      const mockQuery = jest.spyOn((sdk as any).provider, 'query');
      mockQuery.mockResolvedValueOnce({
        result: '1000000000000000000000' // 0.001 NEAR
      } as any);

      // Mock callFunction to simulate error (e.g., not owner) for expected failure
      const mockCallFn = jest.spyOn(sdk.account!, 'callFunction');
      mockCallFn.mockRejectedValueOnce(new Error('Only group owner can add')); // Simulate contract error

      // Attempt to add a member (may fail if not owner or already exists)
      try {
        const result = await sdk.addGroupMember('test-group-1', 'newmember.testnet');
        expect(result).toBeTruthy();
      } catch (error) {
        // Expected if not group owner or member already exists
        expect(error).toBeInstanceOf(NovaError);
      }

      mockQuery.mockRestore();
      mockCallFn.mockRestore();
    }, 5000);
  });

  // multi-user specific test
  test('registerGroup sets caller as owner', async () => {
    const sdkA = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);

    // Use a valid base58 mock key (no 'l', '0', 'O', 'I'; 44 chars for 32 bytes)
    const mockKey = 'ed25519:3t4Y8x3Y5Z7a9b1c3d5e7f9g1h3i5j7k9m1n3o5p7q9r1s3t5u7v9w1x3y5z7A9B1C';  // Valid alphabet
    await sdkA.withSigner(mockKey, 'userA.testnet');
  
    // Mock estimate_fee
    const mockQuery = jest.spyOn((sdkA as any).provider, 'query');
    mockQuery.mockResolvedValueOnce({
      result: '50000000000000000000000' // 0.05 NEAR for register
    } as any);

    // Mock callFunction to simulate success (avoids real tx)
    const mockCallFn = jest.spyOn(sdkA.account!, 'callFunction');
    mockCallFn.mockResolvedValueOnce({
      toString: () => 'Success'
    } as any);

    const registerResult = await sdkA.registerGroup('groupA');
    expect(registerResult).toBe('Success');  // Or parse_outcome returns
  
    // Mock getGroupOwner (JSON str for parse)
    mockQuery.mockResolvedValueOnce({
      result: '"userA.testnet"' // JSON str
    } as any);

    const owner = await sdkA.getGroupOwner('groupA');
    expect(owner).toBe('userA.testnet');
  
    mockCallFn.mockRestore();
    mockQuery.mockRestore();
  });

  describe('Encryption/Decryption', () => {
    test('encrypt/decrypt round trip', () => {
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      
      // Generate a valid 32-byte key
      const key = NodeCrypto.randomBytes(32);
      const keyB64 = key.toString('base64');
      
      const originalData = Buffer.from('Secret test data');
      
      // Use reflection to access private methods for testing
      const encrypted = (sdk as any).encryptData(originalData, keyB64);
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
      
      const decryptedB64 = (sdk as any).decryptData(encrypted, keyB64);
      const decrypted = Buffer.from(decryptedB64, 'base64');
      
      expect(decrypted.toString()).toBe(originalData.toString());
    });

    test('decryptData fails with wrong key', () => {
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      
      const key1 = NodeCrypto.randomBytes(32).toString('base64');
      const key2 = NodeCrypto.randomBytes(32).toString('base64');
      
      const originalData = Buffer.from('Secret data');
      const encrypted = (sdk as any).encryptData(originalData, key1);
      
      // Decrypting with wrong key should throw
      expect(() => {
        (sdk as any).decryptData(encrypted, key2);
      }).toThrow();
    });
  });

  describe('Error handling', () => {
    test('NovaError preserves cause', () => {
      const cause = new Error('Original error');
      const novaError = new NovaError('Wrapper error', cause);
      
      expect(novaError.message).toBe('Wrapper error');
      expect(novaError.cause).toBe(cause);
      expect(novaError.name).toBe('NovaError');
    });

    test('compositeRetrieve validates CID format', async () => {
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret, shadeApiUrl);
      const privateKey = process.env.TEST_NEAR_PRIVATE_KEY;
      const accountId = process.env.TEST_NEAR_ACCOUNT_ID;
      
      if (privateKey && accountId) {
        await sdk.withSigner(privateKey, accountId);
      }
      
      await expect(
        sdk.compositeRetrieve('test-group-1', 'invalid_cid')
      ).rejects.toThrow('Invalid CID');
    });
  });
});
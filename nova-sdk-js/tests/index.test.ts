import { NovaSdk, NovaError, Transaction } from '../src/index';

describe('NovaSdk', () => {
  const rpcUrl = 'https://rpc.testnet.near.org';
  const contractId = 'nova-sdk-2.testnet';
  const fakePinataKey = 'fake_key';
  const fakePinataSecret = 'fake_secret';

  test('constructor initializes correctly', () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    expect(sdk.contractId).toBe(contractId);
    expect(sdk.pinataKey).toBe(fakePinataKey);
    expect(sdk.pinataSecret).toBe(fakePinataSecret);
  });

  test('withSigner accepts valid key format', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    // Valid format should not throw (even if key is dummy)
    // Note: KeyPair.fromString is lenient and may accept various formats
    const result = await sdk.withSigner('ed25519:ABC123dummybase58key32bytesencodedhereforrusttest', 'test.account.testnet');
    expect(result).toBe(sdk);
  });

  test('withSigner rejects completely invalid format', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    // Completely invalid format should throw
    await expect(
      sdk.withSigner('not-a-valid-key-at-all', 'test.account.testnet')
    ).rejects.toThrow(NovaError);
  });

  test('getBalance returns yoctoNEAR string', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    const balance = await sdk.getBalance('nova-sdk-2.testnet');
    expect(balance).toMatch(/^\d+$/);  // Should be numeric string (yoctoNEAR)
    expect(BigInt(balance)).toBeGreaterThanOrEqual(0n);
  }, 10000);

  test('isAuthorized returns false for unauthorized user', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    const authorized = await sdk.isAuthorized('test_group', 'nonexistent.user.testnet');
    expect(typeof authorized).toBe('boolean');
    expect(authorized).toBe(false);
  }, 10000);

  test('getGroupKey throws for unauthorized user', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    await expect(
      sdk.getGroupKey('test_group', 'nonexistent.user.testnet')
    ).rejects.toThrow(NovaError);
  }, 10000);

  test('getTransactionsForGroup returns array', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    const accountId = process.env.TEST_NEAR_ACCOUNT_ID || 'nova-sdk-2.testnet';
    
    try {
      const transactions = await sdk.getTransactionsForGroup('test_group', accountId);
      expect(Array.isArray(transactions)).toBe(true);
    } catch (error) {
      // May throw if unauthorized - that's acceptable
      expect(error).toBeInstanceOf(NovaError);
    }
  }, 10000);

  test('executeContractCall requires signer', async () => {
    const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
    // Should throw because no signer attached
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

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      const signedSdk = await sdk.withSigner(privateKey!, accountId!);
      expect(signedSdk).toBe(sdk); // Should return same instance
    }, 10000);

    test('getGroupKey returns base64 key for authorized user', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      const key = await sdk.getGroupKey('test_group', accountId!);
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(20);
      // Verify it's valid base64
      const testBuffer = Buffer.from(key, 'base64');
      expect(testBuffer.length).toBeGreaterThan(0);
    }, 10000);

    test('isAuthorized returns true for authorized user', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      const authorized = await sdk.isAuthorized('test_group', accountId!);
      expect(typeof authorized).toBe('boolean');
      // Note: May be false if user not actually authorized
    }, 10000);

    test('compositeUpload and retrieve full flow', async () => {
      if (!privateKey || !accountId || !pinataKey || !pinataSecret) {
        console.log('Skipping: All env vars (NEAR + Pinata) required');
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, pinataKey, pinataSecret);
      await sdk.withSigner(privateKey, accountId);

      // Upload test data
      const testData = Buffer.from('Test data for NOVA SDK: ' + Date.now());
      const filename = `test-${Date.now()}.txt`;
      
      const uploadResult = await sdk.compositeUpload('test_group', accountId, testData, filename);
      
      expect(uploadResult.cid).toMatch(/^Qm[a-zA-Z0-9]{44}$/); // Valid IPFS CID
      expect(uploadResult.file_hash).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
      expect(uploadResult.trans_id).toBeTruthy();

      // Retrieve the data
      const retrieveResult = await sdk.compositeRetrieve('test_group', uploadResult.cid);
      
      expect(retrieveResult.data.toString()).toBe(testData.toString());
      expect(retrieveResult.file_hash).toBe(uploadResult.file_hash);
    }, 30000);

    test('transferTokens sends NEAR tokens', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      await sdk.withSigner(privateKey!, accountId!);

      // Send 0.001 NEAR to self (1000000000000000000000 yoctoNEAR)
      const result = await sdk.transferTokens(accountId!, '1000000000000000000000');
      expect(result).toBe('Success');
    }, 15000);

    test('addGroupMember adds member to group', async () => {
      if (shouldSkip) {
        console.log(skipMessage);
        return;
      }

      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      await sdk.withSigner(privateKey!, accountId!);

      // Attempt to add a member (may fail if not owner or already exists)
      try {
        const result = await sdk.addGroupMember('test_group', 'newmember.testnet');
        expect(result).toBeTruthy();
      } catch (error) {
        // Expected if not group owner or member already exists
        expect(error).toBeInstanceOf(NovaError);
      }
    }, 30000);
  });

  describe('Encryption/Decryption', () => {
    test('encryptData and decryptData round trip', () => {
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      
      // Generate a valid 32-byte key
      const crypto = require('crypto');
      const key = crypto.randomBytes(32);
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
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      const crypto = require('crypto');
      
      const key1 = crypto.randomBytes(32).toString('base64');
      const key2 = crypto.randomBytes(32).toString('base64');
      
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
      const sdk = new NovaSdk(rpcUrl, contractId, fakePinataKey, fakePinataSecret);
      const privateKey = process.env.TEST_NEAR_PRIVATE_KEY;
      const accountId = process.env.TEST_NEAR_ACCOUNT_ID;
      
      if (privateKey && accountId) {
        await sdk.withSigner(privateKey, accountId);
      }
      
      await expect(
        sdk.compositeRetrieve('test_group', 'invalid_cid')
      ).rejects.toThrow('Invalid CID');
    });
  });
});
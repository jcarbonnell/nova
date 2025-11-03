import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { KeyPair } from '@near-js/crypto';
import axios from 'axios';
import * as crypto from 'crypto';
import { Buffer } from 'buffer';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

// Set sha512 for noble/ed25519
ed25519.hashes.sha512 = sha512;

export interface Transaction {
  group_id: string;
  user_id: string;
  file_hash: string;
  ipfs_hash: string;
}

export interface CompositeUploadResult {
  cid: string;
  trans_id: string;
  file_hash: string;
}

export interface CompositeRetrieveResult {
  data: Buffer;
  file_hash: string;
}

export class NovaError extends Error {
  constructor(message: string, public cause?: Error) {
    super(message);
    this.name = 'NovaError';
  }
}

export class NovaSdk {
  private provider: JsonRpcProvider;
  private account?: Account;
  private privateKeyStr?: string;
  public contractId: string;
  public pinataKey: string;
  public pinataSecret: string;
  public shadeApiUrl: string;

  constructor(rpcUrl: string, contractId: string, pinataKey: string, pinataSecret: string, shadeApiUrl: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.contractId = contractId;
    this.pinataKey = pinataKey;
    this.pinataSecret = pinataSecret;
    this.shadeApiUrl = shadeApiUrl;
  }

  async withSigner(privateKey: string, accountId: string): Promise<this> {
    try {
      this.privateKeyStr = privateKey;
      const keyPair = KeyPair.fromString(privateKey as any);
      const signer = new KeyPairSigner(keyPair);
      
      this.account = new Account(accountId, this.provider, signer);

      return this;
    } catch (e) {
      throw new NovaError('Signing error', e as Error);
    }
  }

  async getBalance(accountId: string): Promise<string> {
    try {
      // Use provider.viewAccount for read-only account state
      const accountView = await this.provider.viewAccount(accountId);
      return accountView.amount.toString();
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  async isAuthorized(groupId: string, userId: string): Promise<boolean> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'is_authorized',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId })).toString('base64'),
        finality: 'final',
      });
      
      const callResult = result as any;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return JSON.parse(decoded) as boolean;
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
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
    
      const callResult = result as any;
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
    
      const callResult = result as any;
      const decoded = Buffer.from(callResult.result).toString().trim();
      return decoded ? JSON.parse(decoded) : null;  // Returns owner AccountId string
    } catch (e) {
      throw new NovaError(`Owner fetch error: ${e}`, e as Error);
    }
  }

  async updateChecksum(groupId: string, checksum: string): Promise<string> {
    if (!this.account) throw new NovaError('No signer attached (must be group owner)');
    try {
      const result = await this.account.callFunction({
        contractId: this.contractId,
        methodName: 'update_checksum',
        args: { group_id: groupId, checksum },
        gas: 50000000000000n,  // 50 TGas
        deposit: 10000000000000000000n,  // 0.00001 NEAR
      });
      return result ? result.toString() : 'Success (group owner only)';
    } catch (e) {
      throw new NovaError(`Checksum update error: ${e} (ensure caller is group owner)`, e as Error);
    }
  }

  async getGroupKey(groupId: string, userId: string): Promise<string> {
    if (!this.account || !this.privateKeyStr) throw new NovaError('No signer attached');
  
    try {
      // Step 1: Generate payload
      const timestamp = BigInt(Date.now()) * 1000000n;  // ms to ns
      const nonceInput = `${groupId}${userId}${timestamp}`;
      const nonceHash = crypto.createHash('sha256').update(nonceInput).digest();
      const nonce = nonceHash.toString('hex');
    
      // Derive ed25519 public key from private (seed[:32])
      let seedBytes: Buffer;
      if (this.privateKeyStr.startsWith('ed25519:')) {
        const seedB58 = this.privateKeyStr.slice(8);
        const seedBytesFull = Buffer.from(bs58.decode(seedB58));
        seedBytes = Buffer.from(seedBytesFull.subarray(0, 32));
      } else {
        throw new NovaError('Invalid private key format');
      }
    
      const publicBytes = ed25519.getPublicKey(new Uint8Array(seedBytes));
      const signingPkB58 = bs58.encode(publicBytes);
    
      const payloadDict = {
        group_id: groupId,
        user_id: userId,
        nonce: nonce,
        timestamp: Number(timestamp),  // JSON can't handle BigInt
        signing_pk_b58: signingPkB58
      };
    
      const payloadStr = JSON.stringify(payloadDict);
      const payloadBytes = Buffer.from(payloadStr);
      const payloadB64 = payloadBytes.toString('base64');
    
      // Step 2: Sign raw payload bytes
      const sigBytes = ed25519.sign(payloadBytes, seedBytes);
      const sigHex = Buffer.from(sigBytes).toString('hex');
    
      // Step 3: Claim token on-chain
      const claimResult = await this.account.callFunction({
        contractId: this.contractId,
        methodName: 'claim_token',
        args: {
          group_id: groupId,
          payload_b64: payloadB64,
          signature_hex: sigHex
        },
        gas: 100000000000000n,
        deposit: 1000000000000000000n  // 0.001 NEAR
      });
    
      if (!claimResult) throw new NovaError('Token claim failed');
    
      // Parse returned token (base64-decoded str)
      const tokenB64 = claimResult.toString();  // Adjust based on actual return
      if (!tokenB64) throw new NovaError('Empty token from claim');
      const tokenBytes = Buffer.from(tokenB64, 'base64');
      const token = tokenBytes.toString('utf-8').replace(/"/g, '').trim();  // Strip quotes
    
      // Step 4: Fetch key from Shade API
      if (!this.shadeApiUrl) throw new NovaError('Shade API URL not set');
    
      const shadeResponse = await axios.post(`${this.shadeApiUrl}/api/key-management/get_key`, {
        group_id: groupId,
        token: token
      }, { timeout: 15000 });
    
      if (shadeResponse.status !== 200) {
        throw new NovaError(`Shade fetch failed: ${shadeResponse.statusText}`);
      }
    
      const shadeData = shadeResponse.data;
      const key = shadeData.key;
      const checksum = shadeData.checksum;
    
      // Step 5: Verify checksum on-chain (new: add here for explicit sequencing)
      const onChainChecksum = await this.getGroupChecksum(groupId);
      if ((onChainChecksum || '').trim() !== (checksum || '').trim()) {
        throw new NovaError('Checksum mismatch: Shade attestation invalid');
      }

      return key;
    } catch (e) {
      throw new NovaError(`Shade key fetch error: ${e}`, e as Error);
    }
  }

  async getTransactionsForGroup(groupId: string, userId: string): Promise<Transaction[]> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'get_transactions_for_group',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId })).toString('base64'),
        finality: 'final',
      });
      
      const callResult = result as any;
      const decoded = Buffer.from(callResult.result).toString();
      return JSON.parse(decoded) as Transaction[];
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  private async executeContractCall(methodName: string, args: object, depositYocto: string): Promise<string> {
    if (!this.account) throw new NovaError('No signer attached');
    try {
      const result = await this.account.callFunction({
        contractId: this.contractId,
        methodName,
        args,
        gas: 300000000000000n,
        deposit: BigInt(depositYocto),
      });
      return result ? result.toString() : 'Success';
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  async registerGroup(groupId: string): Promise<string> {
    // Caller (signer) becomes group owner automatically
    return this.executeContractCall('register_group', { group_id: groupId }, '100000000000000000000000');
  }

  async addGroupMember(groupId: string, userId: string): Promise<string> {
    // Must be signed as group owner
    return this.executeContractCall('add_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
  }

  async revokeGroupMember(groupId: string, userId: string): Promise<string> {
    // Must be signed as group owner
    return this.executeContractCall('revoke_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
  }

  async recordTransaction(groupId: string, userId: string, fileHash: string, ipfsHash: string): Promise<string> {
    const result = await this.executeContractCall('record_transaction', {
      group_id: groupId,
      user_id: userId,
      file_hash: fileHash,
      ipfs_hash: ipfsHash,
    }, '2000000000000000000000');
    return result;
  }

  async transferTokens(toAccount: string, amountYocto: string): Promise<string> {
    if (!this.account) throw new NovaError('No signer attached');
    try {
      await this.account.transfer({ receiverId: toAccount, amount: BigInt(amountYocto) });
      return 'Success';
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  async compositeUpload(groupId: string, userId: string, data: Buffer, filename: string): Promise<CompositeUploadResult> {
    // Any authorized user (including group owner) can record
    const keyB64 = await this.getGroupKey(groupId, userId);
    const encryptedB64 = this.encryptData(data, keyB64);
    const cid = await this.ipfsUpload(encryptedB64, filename);
    const fileHash = this.computeHash(data).toString('hex');
    const transId = await this.recordTransaction(groupId, userId, fileHash, cid);
    return { cid, trans_id: transId, file_hash: fileHash };
  }

  async compositeRetrieve(groupId: string, ipfsHash: string): Promise<CompositeRetrieveResult> {
    if (!ipfsHash.startsWith('Qm')) throw new NovaError(`Invalid CID: ${ipfsHash}`);
    const userId = this.account!.accountId;
    const keyB64 = await this.getGroupKey(groupId, userId);
    const encryptedB64 = await this.ipfsRetrieve(ipfsHash);
    const decryptedB64 = this.decryptData(encryptedB64, keyB64);
    const data = Buffer.from(decryptedB64, 'base64');
    const fileHash = this.computeHash(data).toString('hex');
    return { data, file_hash: fileHash };
  }

  private encryptData(data: Buffer, keyB64: string): string {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new NovaError('Invalid key length');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(data);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const result = Buffer.concat([iv, encrypted]);
    return result.toString('base64');
  }

  private decryptData(encryptedB64: string, keyB64: string): string {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new NovaError('Invalid key length');
    const encrypted = Buffer.from(encryptedB64, 'base64');
    if (encrypted.length < 16) throw new NovaError('Invalid encrypted data');
    const iv = Uint8Array.prototype.slice.call(encrypted, 0, 16);
    const ciphertext = Uint8Array.prototype.slice.call(encrypted, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('base64');
  }

  private async ipfsUpload(dataB64: string, filename: string): Promise<string> {
    const data = Buffer.from(dataB64, 'base64');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', data, { filename });
    const response = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
      headers: {
        ...form.getHeaders(),
        'pinata_api_key': this.pinataKey,
        'pinata_secret_api_key': this.pinataSecret,
      },
    });
    return response.data.IpfsHash;
  }

  private async ipfsRetrieve(cid: string, retries = 3): Promise<string> {
    let url = `https://gateway.pinata.cloud/ipfs/${cid}`;
    for (let i = 0; i < retries; i++) {
      try {
        const response = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' });
        return Buffer.from(response.data).toString('base64');
      } catch (e) {
        if (i === retries - 1) {
          url = `https://ipfs.io/ipfs/${cid}`;
          const fallback = await axios.get(url, { timeout: 15000, responseType: 'arraybuffer' });
          return Buffer.from(fallback.data).toString('base64');
        }
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
    throw new NovaError('IPFS retrieve failed');
  }

  private computeHash(data: Buffer): Buffer {
    return crypto.createHash('sha256').update(data).digest();
  }
}
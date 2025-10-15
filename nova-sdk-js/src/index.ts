import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { KeyPair } from '@near-js/crypto';
import axios from 'axios';
import * as crypto from 'crypto';
import { Buffer } from 'buffer';

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
  public contractId: string;
  public pinataKey: string;
  public pinataSecret: string;

  constructor(rpcUrl: string, contractId: string, pinataKey: string, pinataSecret: string) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
    this.contractId = contractId;
    this.pinataKey = pinataKey;
    this.pinataSecret = pinataSecret;
  }

  async withSigner(privateKey: string, accountId: string): Promise<this> {
    try {
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
      const decoded = Buffer.from(callResult.result).toString();
      return JSON.parse(decoded) as boolean;
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  async getGroupKey(groupId: string, userId: string): Promise<string> {
    try {
      const result = await this.provider.query({
        request_type: 'call_function',
        account_id: this.contractId,
        method_name: 'get_group_key',
        args_base64: Buffer.from(JSON.stringify({ group_id: groupId, user_id: userId })).toString('base64'),
        finality: 'final',
      });
      
      const callResult = result as any;
      const decoded = Buffer.from(callResult.result).toString();
      return JSON.parse(decoded) as string;
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
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
      return result ? 'Success' : 'No result';
    } catch (e) {
      throw new NovaError(`Near RPC error: ${e}`, e as Error);
    }
  }

  async registerGroup(groupId: string): Promise<string> {
    return this.executeContractCall('register_group', { group_id: groupId }, '100000000000000000000000');
  }

  async addGroupMember(groupId: string, userId: string): Promise<string> {
    return this.executeContractCall('add_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
  }

  async revokeGroupMember(groupId: string, userId: string): Promise<string> {
    return this.executeContractCall('revoke_group_member', { group_id: groupId, user_id: userId }, '500000000000000000');
  }

  async storeGroupKey(groupId: string, keyB64: string): Promise<string> {
    return this.executeContractCall('store_group_key', { group_id: groupId, key: keyB64 }, '500000000000000000');
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
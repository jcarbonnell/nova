// shade-agent/src/lib/services/rekey.ts
//
// §5.12 L3 — re-key a pre-switch CUSTODIAL account, inside Shade on the new CVM.
//
// The attacker holds every custodial key stored before 2026-11-12 (leaked secret
// + public KV). For each account on a FIXED allowlist, this job:
//   1. reads the account's pre-switch record (user:{sub} in nova-kv.near, under
//      the legacy secret) and checks that its private key derives its public key
//      and that this key is a FullAccess key of the account on chain;
//   2. generates a NEW key inside the TEE and stores it in the CURRENT KV as
//      `rekey-pending:{account}` BEFORE anything is sent, so a failure can never
//      lose it (a re-run reuses the same pending key, never draws another);
//   3. sends ONE transaction, signed by the account with its old key:
//      AddKey(new, FullAccess) + DeleteKey(every other key). A transaction applies
//      whole or not at all: there is no moment where both keys, or neither, work;
//   4. verifies on chain that the new key is now the account's ONLY key;
//   5. writes account:{id} and user:{sub} in the current KV with the new key, and
//      overwrites the pending record without its private key.
// Re-runs are safe: done → nothing; pending + old key still on chain → the same
// transaction again; pending + new key already alone on chain → step 5 only.
//
// Group keys are NOT rotated (a divergence from the roadmap's L3 wording, recorded
// 2026-11-13): since L2, every new file key is wrapped under the NEW seed, which
// the attacker does not hold, so a rotation would add nothing. API keys need no
// copy: pre-switch API keys are dead by design; the owner generates a new one.
//
// Operator-triggered only: POST /rpc/migration/rekey behind X-Internal-Auth.
// Without { confirm: true } it returns the plan and changes nothing. The response
// never carries a private key. Mainnet only.
//
// ⚠️ Crypto/key path — harness: test/test-rekey.mjs (+ mutate-rekey.mjs).

import crypto from 'crypto';
import bs58 from 'bs58';
import * as ed25519 from '@noble/ed25519';

import { encryptBlob, decryptBlob, sha256Hex, hashForLog } from '../crypto.js';
import {
  getBlobFromKVStrict, storeBlobToKV, rpcCallWithRetry, withSignerLock,
  encodeTransaction, borshU64, KV_CONTRACT, type BroadcastResult,
} from '../kv.js';
import { readRecord } from '../legacy.js';
import { getRpcUrl } from '../near.js';
import { log } from '../logger.js';
import { ApiError } from '../errors.js';

/** The only accounts this job will ever touch. Changing it is a reviewed image change. */
export const REKEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'gmail-14.nova-sdk.near',
  'hello-partage.nova-sdk.near',
]);

const ED = 'ed25519:';
const pendingIdFor = (accountId: string) => sha256Hex(`rekey-pending:${accountId}`);
const accountIdFor = (accountId: string) => sha256Hex(`account:${accountId}`);
const userIdFor = (sub: string) => sha256Hex(`user:${sub}`);

export interface RekeyInput { account_id: string; sub: string; confirm?: boolean }

const refuse = (status: 400 | 403 | 404 | 500 | 503, code: string, msg: string) => new ApiError(status, code, msg);

interface UserRecord {
  account_id: string; private_key: string; public_key: string; network: string;
  wallet_id: string | null; created_at?: string; rekeyed_at?: string;
}

async function readJson(keyId: string): Promise<{ data: Record<string, unknown>; era: string } | null> {
  const rec = await readRecord(keyId);
  if (!rec) return null;
  try {
    return { data: JSON.parse(Buffer.from(rec.bytes).toString('utf8')), era: rec.era };
  } catch {
    throw refuse(500, 'REKEY_RECORD_UNREADABLE', 'A stored record is unreadable');
  }
}

/** The seed of a NEAR ed25519 secret, if it derives `publicKey`; otherwise null. */
async function seedMatching(privateKey: unknown, publicKey: unknown): Promise<Uint8Array | null> {
  if (typeof privateKey !== 'string' || typeof publicKey !== 'string') return null;
  let bytes: Uint8Array;
  try { bytes = bs58.decode(privateKey.startsWith(ED) ? privateKey.slice(ED.length) : privateKey); } catch { return null; }
  if (bytes.length !== 32 && bytes.length !== 64) return null;
  const seed = bytes.slice(0, 32);
  const pub = await ed25519.getPublicKeyAsync(seed);
  if (bytes.length === 64 && !Buffer.from(bytes.slice(32)).equals(Buffer.from(pub))) return null;
  const want = publicKey.startsWith(ED) ? publicKey : `${ED}${publicKey}`;
  return `${ED}${bs58.encode(pub)}` === want ? seed : null;
}

async function accessKeys(rpcUrl: string, accountId: string): Promise<Array<{ public_key: string; full: boolean }>> {
  const r = await rpcCallWithRetry(rpcUrl, {
    jsonrpc: '2.0', id: 'rekey-keys', method: 'query',
    params: { request_type: 'view_access_key_list', finality: 'final', account_id: accountId },
  }) as { keys?: Array<{ public_key: string; access_key: { permission: unknown } }> } | null;
  if (!r?.keys) throw refuse(503, 'REKEY_CHAIN_UNAVAILABLE', 'Access key list unavailable; retry');
  return r.keys.map((k) => ({ public_key: k.public_key, full: k.access_key.permission === 'FullAccess' }));
}

// Borsh actions (nearcore: Action::AddKey = 5, Action::DeleteKey = 6;
// AccessKeyPermission::FullAccess = 1; PublicKey = [0 = ed25519][32 bytes]).
const pkBytes = (pk: string) => Buffer.concat([Buffer.from([0]), Buffer.from(bs58.decode(pk.slice(ED.length)))]);
export const encodeAddFullAccessKey = (pk: string) => Buffer.concat([Buffer.from([5]), pkBytes(pk), borshU64(0n), Buffer.from([1])]);
export const encodeDeleteKey = (pk: string) => Buffer.concat([Buffer.from([6]), pkBytes(pk)]);

/** Re-key one allowlisted custodial account. See the header for the steps. */
export async function rekeyAccount(input: RekeyInput) {
  const { account_id, sub, confirm } = input;

  // 0. Allowlist — before any KV or chain read.
  if (!REKEY_ALLOWLIST.has(account_id)) {
    throw refuse(403, 'REKEY_NOT_ALLOWED', `Account not on the re-key allowlist: ${account_id}`);
  }
  const rpcUrl = getRpcUrl('mainnet');

  // Already done? (idempotent)
  const current = await getBlobFromKVStrict(accountIdFor(account_id));
  if (current) {
    const rec = JSON.parse(Buffer.from(decryptBlob(current)).toString('utf8')) as UserRecord;
    if (rec.rekeyed_at) {
      return { account_id, state: 'done' as const, new_public_key: rec.public_key, tx_hash: null, deleted_keys: [] as string[] };
    }
  }

  // 1. The pre-switch record, found by the verified sub, must name this account.
  const user = await readJson(userIdFor(sub));
  if (!user || user.era !== 'legacy') throw refuse(404, 'REKEY_RECORD_NOT_FOUND', 'No pre-switch record for this sub');
  const old = user.data as unknown as UserRecord;
  if (old.account_id !== account_id) throw refuse(403, 'REKEY_SUB_MISMATCH', 'The sub belongs to another account');
  if (old.wallet_id) throw refuse(403, 'REKEY_NOT_CUSTODIAL', 'Wallet-linked account: not re-keyed');
  if ((old.network ?? 'mainnet') !== 'mainnet') throw refuse(400, 'REKEY_NETWORK', 'Mainnet accounts only');
  const oldSeed = await seedMatching(old.private_key, old.public_key);
  if (!oldSeed) throw refuse(500, 'REKEY_KEY_MISMATCH', 'The stored key does not derive its public key');
  const oldPub = `${ED}${bs58.encode(await ed25519.getPublicKeyAsync(oldSeed))}`;

  // 2. The pending key, if an earlier run stored one.
  const pendingBlob = await getBlobFromKVStrict(pendingIdFor(account_id));
  let pending: { new_private_key?: string; new_public_key: string; old_public_key: string; done?: boolean } | null =
    pendingBlob ? JSON.parse(Buffer.from(decryptBlob(pendingBlob)).toString('utf8')) : null;
  if (pending?.done) pending = null; // a finished earlier run whose records were lost: start over

  // 3. The chain.
  const keys = await accessKeys(rpcUrl, account_id);
  const has = (pk: string) => keys.some((k) => k.public_key === pk);
  const finishedOnChain = !!pending && keys.length === 1 && keys[0].public_key === pending.new_public_key && keys[0].full;
  if (!finishedOnChain && !keys.some((k) => k.public_key === oldPub && k.full)) {
    throw refuse(403, 'REKEY_OLD_KEY_ABSENT', 'The stored key is no longer a FullAccess key of this account');
  }
  const toDelete = keys.map((k) => k.public_key).filter((pk) => pk !== pending?.new_public_key);

  if (!confirm) {
    return {
      account_id, state: 'plan' as const, new_public_key: pending?.new_public_key ?? null, tx_hash: null,
      deleted_keys: toDelete, old_public_key: oldPub, pending: !!pending, finished_on_chain: finishedOnChain,
    };
  }

  // 4. Pending key: stored BEFORE anything is sent.
  if (!pending) {
    const seed = crypto.randomBytes(32);
    const pub = `${ED}${bs58.encode(await ed25519.getPublicKeyAsync(seed))}`;
    const secret = `${ED}${bs58.encode(Buffer.concat([seed, Buffer.from(bs58.decode(pub.slice(ED.length)))]))}`;
    pending = { new_private_key: secret, new_public_key: pub, old_public_key: oldPub };
    await storeBlobToKV(pendingIdFor(account_id), encryptBlob(Buffer.from(JSON.stringify(pending), 'utf8')));
  }
  const newPub = pending.new_public_key;
  const newSeed = await seedMatching(pending.new_private_key, newPub);
  if (!newSeed) throw refuse(500, 'REKEY_PENDING_UNREADABLE', 'The pending key is unreadable');

  // 5. One transaction: AddKey(new) + DeleteKey(every other key), signed with the old key.
  let txHash: string | null = null;
  if (!finishedOnChain) {
    const deletes = toDelete.filter((pk) => pk !== newPub);
    const outcome = await withSignerLock(`${account_id}|${oldPub}`, async () => {
      const ak = await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'rekey-nonce', method: 'query',
        params: { request_type: 'view_access_key', finality: 'optimistic', account_id, public_key: oldPub },
      }) as { nonce?: number; block_hash?: string } | null;
      if (!ak || ak.nonce === undefined || !ak.block_hash) {
        throw refuse(403, 'REKEY_OLD_KEY_ABSENT', 'The stored key is no longer on chain');
      }
      const actions = [...(has(newPub) ? [] : [encodeAddFullAccessKey(newPub)]), ...deletes.map(encodeDeleteKey)];
      const txBytes = encodeTransaction(account_id, await ed25519.getPublicKeyAsync(oldSeed), BigInt(ak.nonce) + 1n,
        account_id, bs58.decode(ak.block_hash), actions);
      const signature = await ed25519.signAsync(new Uint8Array(crypto.createHash('sha256').update(txBytes).digest()), oldSeed);
      return await rpcCallWithRetry(rpcUrl, {
        jsonrpc: '2.0', id: 'rekey-broadcast', method: 'broadcast_tx_commit',
        params: [Buffer.concat([txBytes, Buffer.from([0]), Buffer.from(signature)]).toString('base64')],
      }) as BroadcastResult;
    });
    if (outcome?.status?.Failure) {
      throw refuse(500, 'REKEY_TX_FAILED', `Re-key transaction failed: ${JSON.stringify(outcome.status.Failure).slice(0, 200)}`);
    }
    txHash = outcome?.transaction?.hash ?? null;
  }

  // 6. Verify: the new key is the account's ONLY key, FullAccess.
  const after = await accessKeys(rpcUrl, account_id);
  if (!(after.length === 1 && after[0].public_key === newPub && after[0].full)) {
    throw refuse(500, 'REKEY_UNVERIFIED', 'The chain does not show the new key as the only key; records not written');
  }

  // 7. Records under the new key, then the pending record without its secret.
  const record: UserRecord = {
    account_id, private_key: pending.new_private_key!, public_key: newPub, network: 'mainnet', wallet_id: null,
    created_at: old.created_at, rekeyed_at: new Date().toISOString(),
  };
  const blob = encryptBlob(Buffer.from(JSON.stringify(record), 'utf8'));
  await storeBlobToKV(accountIdFor(account_id), blob);
  await storeBlobToKV(userIdFor(sub), blob);
  await storeBlobToKV(pendingIdFor(account_id),
    encryptBlob(Buffer.from(JSON.stringify({ done: true, new_public_key: newPub, old_public_key: oldPub }), 'utf8')));

  log('warn', 'account_rekeyed', { account_id_hash: hashForLog(account_id), tx_hash: txHash, deleted: toDelete.length, kv: KV_CONTRACT });
  return { account_id, state: 'rekeyed' as const, new_public_key: newPub, tx_hash: txHash, deleted_keys: toDelete };
}

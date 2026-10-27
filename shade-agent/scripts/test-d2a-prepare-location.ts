// shade-agent/scripts/test-d2a-prepare-location.ts
// Deliverable 2 (A) — prepare_upload hands out the FastFS location BEFORE the
// write, and it is exactly the location the write later produces.
//
//   npx tsx scripts/test-d2a-prepare-location.ts
//
// No network: a throwaway master seed (never the production one) and stubbed
// RPC (axios + fetch). Runs the REAL prepareFileUpload, uploadAt and the REAL
// oRPC output schema.
//
// Invariants:
//   H1  prepareFileUpload returns location === encodeFastfsLocation(file_ref)
//   H2  uploadAt(file_ref) returns that SAME location (prepare == write)
//   H3  PrepareFileUploadOutput keeps `location` (Zod would strip an unknown key)
//   H4  the location parses back to file_ref, under the configured predecessor/receiver
//   H5  prepare's response is otherwise unchanged (file_key, file_ref, version)

import crypto from 'crypto';
import assert from 'node:assert/strict';
import axios from 'axios';
import bs58 from 'bs58';

// Throwaway TEE secret, set BEFORE any src module loads (hence dynamic imports
// below: static imports are hoisted above this line). Refuse if one is already
// in the environment — this harness must never run with a real secret.
if (process.env.TEE_KEY_SECRET) {
  console.error('Refusing to run: TEE_KEY_SECRET is set in this shell. Unset it (no .env) and retry.');
  process.exit(2);
}
process.env.TEE_KEY_SECRET = crypto.randomBytes(32).toString('hex');

import { setMasterSeed } from '../src/lib/crypto.js';
import { encodeFastfsLocation, parseFastfsLocation, uploadAt } from '../src/lib/fastfs.js';
import { prepareFileUpload } from '../src/lib/services/fastfs-storage.js';
import { PrepareFileUploadOutput } from '../src/lib/schemas.js';

const CONTRACT = 'nova-sdk.near';
const GROUP = 'd2a-harness-group';

// ── throwaway seed ──
setMasterSeed(new Uint8Array(crypto.randomBytes(32)));

// ── RPC stub (one answer table for axios and fetch) ──
const seen: string[] = [];
const bytes = (s: string) => Array.from(Buffer.from(s, 'utf8'));

function rpcAnswer(payload: any): unknown {
  const p = payload?.params;
  const method = payload?.method;
  if (method === 'query' && p?.request_type === 'call_function') {
    seen.push(`view:${p.account_id}.${p.method_name}`);
    if (p.method_name === 'get') return { result: bytes('null') };          // KV: nothing stored (no rotation)
    if (p.method_name === 'is_authorized') return { result: bytes('true') };
    if (p.method_name === 'group_contains_key') return { result: bytes('true') };
    throw new Error(`unexpected view ${p.method_name}`);
  }
  if (method === 'query' && p?.request_type === 'view_access_key') {
    seen.push('view_access_key');
    return { nonce: 1, block_hash: bs58.encode(new Uint8Array(32)) };
  }
  if (method === 'broadcast_tx_commit') {
    seen.push('broadcast');
    // KV store → success. FastFS envelope → the expected CodeDoesNotExist no-op.
    const tx = Buffer.from(p[0], 'base64').toString('latin1');
    const isFastfs = tx.includes('__fastdata_fastfs');
    return isFastfs
      ? { transaction: { hash: 'H' }, status: { Failure: { ActionError: { kind: { FunctionCallError: { CompilationError: { CodeDoesNotExist: { account_id: 'fastfs.near' } } } } } } } }
      : { transaction: { hash: 'H' }, status: { SuccessValue: '' } };
  }
  throw new Error(`unexpected RPC ${method}`);
}

(axios as any).post = async (_url: string, payload: any) => ({ data: { jsonrpc: '2.0', id: payload?.id, result: rpcAnswer(payload) } });
(globalThis as any).fetch = async (_url: string, init: any) => {
  const payload = JSON.parse(String(init?.body ?? '{}'));
  const body = { jsonrpc: '2.0', id: payload?.id, result: rpcAnswer(payload) };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

// ── tests ──
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const prep = await prepareFileUpload({ group_id: GROUP, account_id: 'alice.near', contract_id: CONTRACT });

await test('H1 prepare returns location === encodeFastfsLocation(file_ref)', async () => {
  assert.equal((prep as any).location, encodeFastfsLocation(prep.file_ref));
});

await test('H2 uploadAt(file_ref) produces the SAME location', async () => {
  const written = await uploadAt(new Uint8Array([1, 2, 3]), prep.file_ref);
  assert.equal(written.location, (prep as any).location);
  assert.ok(seen.includes('broadcast'), 'uploadAt did not reach the (stubbed) broadcast');
});

await test('H3 PrepareFileUploadOutput keeps location (not stripped)', async () => {
  const out = PrepareFileUploadOutput.parse(prep) as Record<string, unknown>;
  assert.equal(out.location, (prep as any).location);
});

await test('H4 location parses back to file_ref under predecessor/receiver', async () => {
  const parsed = parseFastfsLocation((prep as any).location);
  assert.equal(parsed.relativePath, prep.file_ref);
  assert.equal(parsed.predecessor, process.env.FASTFS_PREDECESSOR || 'nova-sdk.near');
  assert.equal(parsed.receiver, process.env.FASTFS_RECEIVER || 'fastfs.near');
});

await test('H5 the rest of the response is unchanged', async () => {
  assert.deepEqual(Object.keys(prep).sort(), ['file_key', 'file_ref', 'location', 'version']);
  assert.equal(Buffer.from(prep.file_key, 'base64').length, 32);
  assert.equal(prep.version, 'base');
});

console.log(`\n${5 - failed}/5 passed`);
process.exit(failed ? 1 : 0);
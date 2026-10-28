// test-d2a-wallet-smoke.mjs
// Deliverable 2 (A) LIVE smoke: every self-custodial write signed by the user's own
// wallet against PROD (mainnet contract nova-sdk.near, MCP v0.4.12). NOVA never sees
// the wallet key: the signer below shells out to near-cli, which reads
// ~/.near-credentials/mainnet/<account>.json itself. This script never opens that file.
//
// Order (§10): health → security invariants → happy path (all through the SDK).
//   setup      register the wallet-owned fixture group (0.64 NEAR, once; skipped on re-run)
//   invariant  I1 finalize_upload with NO tx_hash from a wallet session → refused
//              I2 finalize_upload with a tx NOT recording this upload → refused
//   happy      add member → member list (reader path) → upload (record-first) →
//              file row on chain → retrieve byte-identical → revoke → owner still reads
//              the earlier file → retention set 30 → cleared
//
// RUN (from nova-sdk-js/, after `npm run build`):
//   read -rs IH_API_KEY && export IH_API_KEY      # ironclaw-hackathon.near API key
//   node test-d2a-wallet-smoke.mjs
// Optional: SMOKE_GROUP (default d2-wallet-fixture), SMOKE_MEMBER (default gmail-14.nova-sdk.near)

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pkg from './dist/index.js';
const { NovaSdk, NovaError } = pkg;
const run = promisify(execFile);

const MCP_URL = process.env.MCP_URL
  || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const ACCOUNT = 'ironclaw-hackathon.near';
const GROUP = process.env.SMOKE_GROUP || 'd2-wallet-fixture';
const MEMBER = process.env.SMOKE_MEMBER || 'gmail-14.nova-sdk.near';
const API_KEY = process.env.IH_API_KEY;
if (!API_KEY) { console.error('Set IH_API_KEY (ironclaw-hackathon.near API key) via read -rs.'); process.exit(1); }

// ── wallet signer: near-cli signs with the account's own key, we only parse the tx id ──
const walletLog = [];
const walletSigner = {
  accountId: ACCOUNT,
  async signAndSendFunctionCall(call) {
    const args = ['call', call.receiverId, call.methodName, JSON.stringify(call.args),
      '--accountId', ACCOUNT, '--networkId', 'mainnet',
      '--gas', call.gas.toString(), '--depositYocto', call.deposit.toString()];
    let out;
    try {
      out = await run('near', args, { maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      // near-cli prints its usage block FIRST and the actual error LAST: keep the tail.
      const all = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`;
      const cause = all.split('\n').filter(l => /Error|error|Failure|panicked|Unknown|Missing|Invalid/.test(l));
      throw new Error(`near call ${call.methodName} failed: ${cause.join(' | ').slice(-800) || all.slice(-800)}`);
    }
    const m = /Transaction Id (\w+)/.exec(out.stdout + out.stderr);
    if (!m) throw new Error(`near call ${call.methodName}: no transaction id in output`);
    walletLog.push(`${call.methodName} ${m[1]} (deposit ${call.deposit} yocto)`);
    return { txHash: m[1] };
  },
};

const sdk = new NovaSdk(ACCOUNT, { mcpUrl: MCP_URL, apiKey: API_KEY, walletSigner });
const mcp = (tool, args) => sdk['callMcpTool'](tool, args); // raw tool call, same session
const step = (s) => console.log(`  ✓ ${s}`);

async function refused(label, fn) {
  try { await fn(); } catch (e) {
    assert.ok(e instanceof NovaError, `${label}: expected NovaError, got ${e}`);
    step(`${label} — refused: ${String(e.message).slice(0, 160)}`);
    return;
  }
  assert.fail(`SECURITY FAIL: ${label} was accepted`);
}

console.log(`\nD2 (A) live wallet smoke — MCP=${MCP_URL}\n  wallet=${ACCOUNT} group=${GROUP} member=${MEMBER}\n`);

// ── health ───────────────────────────────────────────────────────────────────
const health = await (await fetch(`${MCP_URL}/health`)).json();
assert.equal(health.version, '0.4.12', `unexpected MCP version ${health.version}`);
assert.equal(health.rpc_reachable, true);
assert.equal(sdk.signerMode, 'wallet');
step(`health — MCP ${health.version}, rpc reachable, SDK in wallet mode`);

// ── setup: wallet-owned fixture group ─────────────────────────────────────────
const existingOwner = await sdk.getGroupOwner(GROUP).catch(() => null);
if (existingOwner === null) {
  await sdk.registerGroup(GROUP);
  step(`registerGroup('${GROUP}') — wallet-signed register_group, MCP created the group key`);
} else {
  assert.equal(existingOwner, ACCOUNT, `'${GROUP}' exists but is owned by ${existingOwner}: pick another SMOKE_GROUP`);
  step(`'${GROUP}' already owned by the wallet — register skipped (re-run)`);
}
assert.equal(await sdk.getGroupOwner(GROUP), ACCOUNT);
assert.equal(await sdk.isAuthorized(GROUP), true);
step('on chain: owner = wallet, wallet is a member');

// ── security invariants: no bytes without the wallet's own record ─────────────
{
  const p = await mcp('prepare_upload', { group_id: GROUP, filename: 'invariant-1.txt' });
  assert.ok(p.location, 'wallet session must get a location from prepare_upload');
  await refused('I1 finalize_upload without tx_hash (wallet session)', () => mcp('finalize_upload', {
    upload_id: p.upload_id, encrypted_data: Buffer.from('junk').toString('base64'),
    file_hash: 'ab'.repeat(32), format: null,
  }));
}
{
  // a real mainnet tx that is NOT this wallet recording this upload (the reader-key add, signed by nova-sdk.near)
  const p = await mcp('prepare_upload', { group_id: GROUP, filename: 'invariant-2.txt' });
  await refused('I2 finalize_upload with a foreign tx_hash', () => mcp('finalize_upload', {
    upload_id: p.upload_id, encrypted_data: Buffer.from('junk').toString('base64'),
    file_hash: 'cd'.repeat(32), format: null, tx_hash: '4nwJ6tZGmLyoou6Pvd4L5ycHit721yg9BNsbQ5L9Xzy1',
  }));
}
assert.deepEqual(await sdk.getTransactionsForGroup(GROUP).then(r => r.filter(t => /^(ab|cd)+$/.test(t.file_hash))), [],
  'a refused finalize left a record on chain');
step('no record on chain for either refused upload');

// ── happy path ───────────────────────────────────────────────────────────────
if (!(await sdk.isAuthorized(GROUP, MEMBER))) {
  await sdk.addGroupMember(GROUP, MEMBER);
}
assert.equal(await sdk.isAuthorized(GROUP, MEMBER), true);
step(`addGroupMember(${MEMBER}) — wallet-signed add_group_member`);

const members = await sdk.getGroupMembers(GROUP);
assert.deepEqual([...members].sort(), [ACCOUNT, MEMBER].sort());
step(`getGroupMembers — reader path → ${members.join(', ')}`);

const data = Buffer.concat([Buffer.from(`D2(A) smoke ${new Date().toISOString()}\n`), randomBytes(4096)]);
const up = await sdk.upload(GROUP, data, 'd2a-smoke.bin');
assert.ok(up.cid && up.trans_id, `upload returned ${JSON.stringify(up)}`);
step(`upload — record-first: wallet record_transaction, then bytes → ${up.cid}`);

const rows = await sdk.getTransactionsForGroup(GROUP);
const row = rows.find(r => r.trans_id === up.trans_id);
assert.ok(row, 'uploaded file not in the group index');
assert.equal(row.user_id, ACCOUNT);
assert.equal(row.ipfs_hash, up.cid);
assert.equal(row.file_hash, sdk.computeHash(data));
assert.equal(row.backend, 'FastFS');
step('on chain: record by the wallet, plaintext hash and location match');

const back = await sdk.retrieve(GROUP, up.cid);
assert.ok(Buffer.compare(back.data, data) === 0, 'retrieved bytes differ');
step(`retrieve — byte-identical (${data.length} bytes)`);

await sdk.revokeGroupMember(GROUP, MEMBER);
assert.equal(await sdk.isAuthorized(GROUP, MEMBER), false);
step(`revokeGroupMember(${MEMBER}) — wallet-signed revoke, MCP rotated the group key`);

const again = await sdk.retrieve(GROUP, up.cid);
assert.ok(Buffer.compare(again.data, data) === 0, 'owner cannot read the earlier file after rotation');
step('owner still reads the earlier file after the key rotation');

await sdk.setGroupRetention(GROUP, 30);
const ret30 = await sdk['provider'].query({ request_type: 'call_function', account_id: sdk.contractId,
  method_name: 'get_group_retention', args_base64: Buffer.from(JSON.stringify({ group_id: GROUP })).toString('base64'),
  finality: 'final' });
const ret30v = Buffer.from(ret30.result).toString();
assert.match(ret30v, /\b30\b/, `retention not 30 on chain: ${ret30v}`);
step(`setGroupRetention(30) — MCP registry first, then zero-fee wallet call → on chain ${ret30v}`);

await sdk.setGroupRetention(GROUP, null);
const retNull = await sdk['provider'].query({ request_type: 'call_function', account_id: sdk.contractId,
  method_name: 'get_group_retention', args_base64: Buffer.from(JSON.stringify({ group_id: GROUP })).toString('base64'),
  finality: 'final' });
const retNullV = Buffer.from(retNull.result).toString();
assert.doesNotMatch(retNullV, /\b30\b/, `retention not cleared: ${retNullV}`);
step(`setGroupRetention(null) — cleared → on chain ${retNullV}`);

console.log('\n  wallet transactions (for the explorer):');
for (const l of walletLog) console.log(`    ${l}`);
console.log('\nD2 (A) LIVE SMOKE PASS — every write signed by the wallet; MCP only verified and ran side effects.\n');

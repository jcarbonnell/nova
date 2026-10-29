// aa_d23_smoke.mts: D2-3 live smoke, mainnet. An Agent Connect agent uses NOVA self-custodially
// through the reference module ../nova-agent-connect/nova-agent-connect.ts, exactly as an
// integrator would (its own Agent API client, the module, plain nova-sdk-js).
//
// Order: health → security invariants → happy path (member, via connectNovaAgent + nova-sdk-js).
// Owner operations by an agent are NOT proven here (an agent-owned group costs 0.64 NEAR; stated limit).
//
// Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.grant-token):
//   npm i -E @near-intents-agent-api/sdk@0.7.2
//   ../nova-agent-connect/node_modules/.bin/tsx aa_d23_smoke.mts
//   JOIN_GROUP=<joinable group with an open window> ../nova-agent-connect/node_modules/.bin/tsx aa_d23_smoke.mts
//
// Spends from the AGENT's own NEAR account only: at most 3 executed calls (one refused on chain,
// one upload, one optional join), ≈0.0015 NEAR of gas. Writes ./d23-smoke-<ts>.json (no secrets)
// and keeps a pending call in ./.nova-pending.json (no secrets). Never prints naa_/ngt_/session.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAgentApi } from '@near-intents-agent-api/sdk';
import {
  connectNovaAgent, signInAgent, NOVA_CONTRACT_ID, type PendingNativeCall, type PendingStore,
} from '../nova-agent-connect/nova-agent-connect.ts';

const HERE = process.cwd();
const MCP = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const MEMBER_GROUP = 'loadwallet-readpath-test';     // custodially owned; the agent is a member
const NOT_OWNED_GROUP = 'd2-wallet-fixture';          // owned by ironclaw-hackathon.near
const CAP = 10n ** 22n;                               // = the owner's wNEAR per-transaction limit (0.01 NEAR)
const D20_TX = '2GZEEVjiLZL9SBTH3VBvmFD37mEkh7NoH16iotrg1sYj';   // the agent's own D2-0 record
const FOREIGN_TX = 'AQ6ckKoy1BMjeXpR8QpYXiy2UvFQfbBQrPGkXyE9dAZJ'; // a record signed by ironclaw-hackathon.near
const TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const OUT = path.join(HERE, `d23-smoke-${TS}.json`);

const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(HERE, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const aa = JSON.parse(fs.readFileSync(path.join(HERE, 'aa-state.json'), 'utf8'));
const AGENT_ID: string = aa.agent_id;
const RPC = env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com';
const api = createAgentApi({ apiKey: env.NEAR_INTENTS_AGENT_API_KEY, baseUrl: env.NEAR_INTENTS_AGENT_API_URL })
  .forGrant(fs.readFileSync(path.join(HERE, '.grant-token'), 'utf8').trim());

// A durable store: what an integrator's backend needs (a file here; a DB row in production).
const PENDING = path.join(HERE, '.nova-pending.json');
const fileStore: PendingStore = {
  load: async () => (fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) as PendingNativeCall : null),
  save: async (p) => { fs.writeFileSync(PENDING, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 }); },
  clear: async () => { fs.rmSync(PENDING, { force: true }); },
};

const results: { name: string; ok: boolean | 'skipped'; detail?: unknown }[] = [];
const record: Record<string, unknown> = { started_at: new Date().toISOString(), agent_id: AGENT_ID, results };
const save = () => fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
function skip(name: string, why: string) { results.push({ name, ok: 'skipped', detail: why }); console.log(`· SKIPPED ${name} — ${why}`); }
const msg = (e: unknown) => {
  const x = e as any;
  const meta = typeof x?.code === 'string'
    ? ` [${x.status} ${x.code}${x.layer ? ` ${x.layer}` : ''}${x.retryAfterSeconds != null ? ` retry-after ${x.retryAfterSeconds}s` : ''}${x.availableAt ? ` available ${x.availableAt}` : ''}]`
    : '';
  return (String(x?.message ?? e) + meta).slice(0, 400);
};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function rpcBalance(account: string): Promise<bigint | null> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    jsonrpc: '2.0', id: 'b', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }) });
  const j: any = await r.json();
  return j.result ? BigInt(j.result.amount) : null;
}
async function mcpRest(tool: string, body: unknown, token: string, account: string) {
  const r = await fetch(`${MCP}/tools/${tool}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-account-id': account }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function rawNative(body: Record<string, unknown>) {
  try {
    const st = await api.nativeNearCall(AGENT_ID, body as any, { idempotencyKey: `nova-d23-${randomUUID()}` });
    return { accepted: true as const, status: st.status, correlation_id: st.correlation_id, details: (st as any).details };
  } catch (e: any) {
    return { accepted: false as const, status: e.status, code: e.code, layer: e.layer, detail: e.detail };
  }
}

async function main() {
  // ── 0. health ─────────────────────────────────────────────────────────────────────────────
  const h = await fetch(`${MCP}/health`).then(async (r) => ({ status: r.status, body: await r.text() }));
  check('H1 MCP /health is 0.4.12', h.status === 200 && h.body.includes('0.4.12'), h.body.slice(0, 120));
  const net = await api.getNetwork();
  check('H2 Agent API mainnet, operational', net.network === 'mainnet' && net.status.overall === 'operational', `${net.network} ${net.status.overall}`);
  const pol = await api.getPolicy(AGENT_ID);
  const call = pol.policy?.native?.near.call ?? [];
  check('H3 owner policy in force with native.near.call=[nova-sdk.near]',
    pol.status === 'APPLIED' && pol.provider_policy_synced && call.length === 1 && call[0] === NOVA_CONTRACT_ID,
    `rev ${pol.revision} ${pol.status} synced=${pol.provider_policy_synced} call=${JSON.stringify(call)}`);
  const account = (await api.getAgent(AGENT_ID)).wallet?.near_account_id ?? '';
  const bal = await rpcBalance(account);
  record.balance_before = bal?.toString();
  check('H4 agent NEAR account funded (≥ 0.01 NEAR)', bal !== null && bal >= CAP, bal === null ? 'not on chain' : `${Number(bal) / 1e24} NEAR`);
  check('H5 no write pending from an earlier run', !fs.existsSync(PENDING), fs.existsSync(PENDING) ? PENDING : undefined);
  if (results.some((r) => r.ok === false)) { save(); throw new Error('health failed: stopping before anything is signed'); }

  // ── 1. security invariants ────────────────────────────────────────────────────────────────
  // 1a. Agent Connect refuses a contract the owner did not list (bypassing the module's own guard).
  const a = await rawNative({ receiver_id: 'wrap.near', method_name: 'near_deposit', args: {}, gas: '30000000000000', deposit: '1' });
  record.invariant_unlisted_contract = a;
  check('V1 Agent Connect refuses an unlisted contract (wrap.near): 403 native_method_denied',
    !a.accepted && a.status === 403 && a.code === 'native_method_denied', a.accepted ? `ACCEPTED ${a.correlation_id} ${a.status}` : `${a.status} ${a.code} [${a.layer}]`);

  // 1b. Agent Connect refuses a deposit above the owner's wNEAR cap. If it were accepted, the call
  // panics on chain (not the owner) and the deposit is refunded: nothing can be added.
  const b = await rawNative({ receiver_id: NOVA_CONTRACT_ID, method_name: 'add_group_member',
    args: { group_id: NOT_OWNED_GROUP, user_id: 'devbot.near' }, gas: '30000000000000', deposit: (CAP + 1n).toString() });
  record.invariant_over_cap = b;
  check('V2 Agent Connect refuses a deposit above the 0.01 NEAR cap: 409 policy_denied',
    !b.accepted && b.status === 409 && b.code === 'policy_denied' && b.layer === 'policy',
    b.accepted ? `ACCEPTED ${b.correlation_id} ${b.status}` : `${b.status} ${b.code} [${b.layer}]`);

  // 1c/1d. MCP refuses a finalize whose tx is not this upload's record (prepare costs nothing on chain).
  const s = await signInAgent(api, AGENT_ID);
  check('V3 agent signs in to NOVA as its own account', s.accountId === account, s.accountId);
  for (const [name, tx, expected] of [
    ['V4 MCP refuses a record signed by another account', FOREIGN_TX, /Upload record was not signed by this session's account|RPC tx lookup failed/],
    ['V5 MCP refuses the agent\'s own earlier record for a new upload', D20_TX, /Upload record does not match this upload/],
  ] as const) {
    const prep = await mcpRest('prepare_upload', { group_id: MEMBER_GROUP, filename: 'never-written.bin' }, s.token, account);
    const fin = await mcpRest('finalize_upload', { upload_id: prep.body?.result?.upload_id, encrypted_data: 'AA==',
      file_hash: '0'.repeat(64), tx_hash: tx }, s.token, account);
    const err = String(fin.body?.error ?? '');
    check(name, !!prep.body?.result?.location && fin.status !== 200 && expected.test(err), `${fin.status} ${err.slice(0, 120)}`);
  }

  // 1e. The contract refuses the agent's owner operation on a group it does not own (one call, gas only).
  const conn = await connectNovaAgent(api, AGENT_ID, { store: fileStore, maxDepositYocto: CAP });
  const { nova, signer } = conn;
  check('V6 connectNovaAgent → NovaSdk in wallet mode for the agent account', nova.signerMode === 'wallet' && conn.accountId === account);
  try {
    await nova.addGroupMember(NOT_OWNED_GROUP, 'devbot.near');
    check('V7 contract refuses add_group_member on a group the agent does not own', false, 'ACCEPTED');
  } catch (e) {
    const m = msg(e);
    check('V7 contract refuses add_group_member on a group the agent does not own', /add_group_member ended FAILED \(native_request_failed\): Smart contract panicked.*Only group owner can add/s.test(m), m);
  }
  check('V8 no write left pending after the refusal', (await signer.resolvePending()) === null);

  // ── 2. happy path (member) through connectNovaAgent + nova-sdk-js ────────────────────────
  const payload = Buffer.from(JSON.stringify({ kind: 'd2-3-smoke', account, at: new Date().toISOString() }));
  const up = await nova.upload(MEMBER_GROUP, payload, `d2-3-smoke-${TS}.json`);
  record.upload = up;
  check('P1 upload signed and paid by the agent, finalized by MCP', !!up.cid && up.file_hash === sha256(payload), up.cid);
  const got = await nova.retrieve(MEMBER_GROUP, up.cid);
  check('P2 retrieve byte-identical', sha256(Buffer.from(got.data)) === sha256(payload));
  const row = (await nova.getTransactionsForGroup(MEMBER_GROUP)).find((r) => r.ipfs_hash === up.cid);
  check('P3 on-chain row: uploader = agent, file_hash matches', row?.user_id === account && row?.file_hash === up.file_hash,
    row ? `${row.user_id} ${row.trans_id}` : 'missing');

  const join = process.env.JOIN_GROUP;
  if (join) {
    try {
      await nova.joinGroup(join);
      check(`P4 agent joins ${join} itself`, await nova.isAuthorized(join, account));
    } catch (e) { check(`P4 agent joins ${join} itself`, false, msg(e)); }
  } else skip('P4 join_group', 'set JOIN_GROUP=<joinable group with an open window>');

  const after = await rpcBalance(account);
  record.balance_after = after?.toString();
  console.log(`  agent NEAR: ${Number(bal) / 1e24} → ${Number(after) / 1e24} (spent ${(Number(bal! - after!) / 1e24).toFixed(6)})`);
}

main()
  .catch((e) => { check('run completed', false, msg(e)); })
  .finally(() => {
    save();
    const passed = results.filter((r) => r.ok === true).length;
    const failed = results.filter((r) => r.ok === false).length;
    const skipped = results.filter((r) => r.ok === 'skipped').length;
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} SKIPPED (a skip is not a pass) — ${OUT}`);
    process.exitCode = failed ? 1 : 0;
  });

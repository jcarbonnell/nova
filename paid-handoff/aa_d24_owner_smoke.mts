// aa_d24_owner_smoke.mts: live smoke, mainnet. An Agent Connect agent OWNS a NOVA group:
// it registers it, adds a member, uploads, revokes, all signed and paid by its own NEAR account
// through ../nova-agent-connect (per-method caps + methods allowlist). NOVA signs nothing for it.
//
// Order: health → security invariants → owner happy path → revocation.
//
// Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.grant-token):
//   ../nova-agent-connect/node_modules/.bin/tsx aa_d24_owner_smoke.mts
//
// Prerequisites: owner policy wNEAR per-transaction cap ≥ 0.64 NEAR (aa_native.py --enable-call
// --cap-yocto 650000000000000000000000) and ≥ 0.66 NEAR on the agent's NEAR account.
// Spends from the AGENT: 0.64 NEAR register fee + ~0.003 NEAR gas/fees, 4 executed actions
// (register, add, upload, revoke). The member (your custodial NOVA account) spends ~0.015 NEAR
// for one retrieve and one refused add. Writes ./d24-owner-smoke-<ts>.json (no secrets).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentApi } from '@near-intents-agent-api/sdk';
import { NovaSdk } from 'nova-sdk-js';
import {
  agentConnectSigner, signInAgent, NOVA_CONTRACT_ID, type PendingNativeCall, type PendingStore,
} from '../nova-agent-connect/nova-agent-connect.ts';

const HERE = process.cwd();
const MCP = 'https://7e9ff97d35e21fdd0f5c819472217d19e772d017-8000.dstack-base-prod5.phala.network';
const TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const GROUP = `agent-owned-${TS}`;                    // fresh, valid group id
const CAP = 10n ** 22n;                               // 0.01 NEAR for every call but register
const REG_FEE = 640_000_000_000_000_000_000_000n;     // register_group fee, 0.64 NEAR
const OUT = path.join(HERE, `d24-owner-smoke-${TS}.json`);

const env: Record<string, string> = {};
for (const line of fs.readFileSync(path.join(HERE, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const aa = JSON.parse(fs.readFileSync(path.join(HERE, 'aa-state.json'), 'utf8'));
const AGENT_ID: string = aa.agent_id;
const RPC = env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com';
if (!env.NOVA_ACCOUNT_ID || !env.NOVA_API_KEY) throw new Error('NOVA_ACCOUNT_ID / NOVA_API_KEY missing in .env (the member)');
const api = createAgentApi({ apiKey: env.NEAR_INTENTS_AGENT_API_KEY, baseUrl: env.NEAR_INTENTS_AGENT_API_URL })
  .forGrant(fs.readFileSync(path.join(HERE, '.grant-token'), 'utf8').trim());

const PENDING = path.join(HERE, '.nova-pending.json');
const fileStore: PendingStore = {
  load: async () => (fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, 'utf8')) as PendingNativeCall : null),
  save: async (p) => { fs.writeFileSync(PENDING, JSON.stringify(p, null, 2) + '\n', { mode: 0o600 }); },
  clear: async () => { fs.rmSync(PENDING, { force: true }); },
};

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const record: Record<string, unknown> = { started_at: new Date().toISOString(), agent_id: AGENT_ID, group: GROUP, results };
const save = () => fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const msg = (e: unknown) => {
  const x = e as any;
  const meta = typeof x?.code === 'string' ? ` [${x.status} ${x.code}${x.layer ? ` ${x.layer}` : ''}]` : '';
  return (String(x?.message ?? e) + meta).slice(0, 400);
};
const sha256 = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
async function rpcBalance(account: string): Promise<bigint | null> {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    jsonrpc: '2.0', id: 'b', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }) });
  const j: any = await r.json();
  return j.result ? BigInt(j.result.amount) : null;
}
async function refusedWith(name: string, fn: () => Promise<unknown>, re: RegExp) {
  try { await fn(); check(name, false, 'ACCEPTED'); }
  catch (e) { const m = msg(e); check(name, re.test(m), m); }
}

async function main() {
  // ── 0. health ─────────────────────────────────────────────────────────────────────────────
  const h = await fetch(`${MCP}/health`).then(async (r) => ({ status: r.status, body: await r.text() }));
  check('H1 MCP /health is 0.4.12', h.status === 200 && h.body.includes('0.4.12'), h.body.slice(0, 100));
  const pol = await api.getPolicy(AGENT_ID);
  const call = pol.policy?.native?.near.call ?? [];
  const wcap = BigInt(pol.policy?.limits.per_transaction?.['nep141:wrap.near'] ?? '0');
  check('H2 owner policy in force, call=[nova-sdk.near], wNEAR cap ≥ 0.64 NEAR',
    pol.status === 'APPLIED' && pol.provider_policy_synced && call.length === 1 && call[0] === NOVA_CONTRACT_ID && wcap >= REG_FEE,
    `rev ${pol.revision} cap ${Number(wcap) / 1e24} NEAR`);
  const account = (await api.getAgent(AGENT_ID)).wallet?.near_account_id ?? '';
  const bal = await rpcBalance(account);
  record.balance_before = bal?.toString();
  check('H3 agent NEAR account holds ≥ 0.84 NEAR (0.64 deposit + fee headroom)', bal !== null && bal >= REG_FEE + 20n * CAP, `${Number(bal) / 1e24} NEAR`);
  check('H4 no write pending from an earlier run', !fs.existsSync(PENDING));
  const member = new NovaSdk(env.NOVA_ACCOUNT_ID, { apiKey: env.NOVA_API_KEY });
  const free = await member.getGroupOwner(GROUP).then(() => false, () => true);
  check(`H5 group id ${GROUP} is free`, free);
  if (results.some((r) => !r.ok)) { save(); throw new Error('health failed: stopping before anything is signed'); }

  // One sign-in; three signers over the same session.
  const s = await signInAgent(api, AGENT_ID);
  check('H6 agent signs in to NOVA as its own account', s.accountId === account, s.accountId);
  const sdk = (opts: Record<string, unknown>) => new NovaSdk(account, { sessionToken: s.token,
    walletSigner: agentConnectSigner(api, AGENT_ID, account, { store: fileStore, maxDepositYocto: CAP, ...opts } as any) });

  // ── 1. security invariants (local: nothing is sent) ──────────────────────────────────────
  await refusedWith('V1 member-only agent cannot register a group (nothing sent)',
    () => sdk({ methods: ['record_transaction', 'join_group'] }).registerGroup(GROUP), /register_group is not allowed for this agent/);
  await refusedWith('V2 without a register cap, the 0.64 NEAR fee is refused (nothing sent)',
    () => sdk({}).registerGroup(GROUP), /exceeds the cap 10000000000000000000000 for register_group/);
  check('V3 nothing reached the chain: the group still does not exist', await member.getGroupOwner(GROUP).then(() => false, () => true));

  // ── 2. the agent owns a group ─────────────────────────────────────────────────────────────
  const owner = sdk({ maxDepositByMethod: { register_group: REG_FEE } });
  await owner.registerGroup(GROUP);
  const onChainOwner = await member.getGroupOwner(GROUP);
  check('O1 agent registered the group itself (signed + paid by the agent; MCP made the key)', onChainOwner === account, onChainOwner);

  await owner.addGroupMember(GROUP, env.NOVA_ACCOUNT_ID);
  check(`O2 agent added ${env.NOVA_ACCOUNT_ID} as a member`, await member.isAuthorized(GROUP, env.NOVA_ACCOUNT_ID));

  const payload = Buffer.from(JSON.stringify({ kind: 'd2-4-owner-smoke', group: GROUP, at: new Date().toISOString() }));
  const up = await owner.upload(GROUP, payload, `d2-4-${TS}.json`);
  record.upload = up;
  check('O3 agent uploaded into its own group', up.file_hash === sha256(payload), up.cid);

  const got = await member.retrieve(GROUP, up.cid);
  check('O4 the member retrieves it byte-identical', sha256(Buffer.from(got.data)) === sha256(payload));

  await refusedWith('V4 the member cannot administer the agent\'s group (contract)',
    () => member.addGroupMember(GROUP, 'devbot.near'), /Only group owner can add/);

  // ── 3. revocation ─────────────────────────────────────────────────────────────────────────
  await owner.revokeGroupMember(GROUP, env.NOVA_ACCOUNT_ID);
  check('O5 agent revoked the member (MCP rotated the key)', !(await member.isAuthorized(GROUP, env.NOVA_ACCOUNT_ID)));
  await refusedWith('O6 the revoked member can no longer retrieve', () => member.retrieve(GROUP, up.cid), /403|not a member|not authorized|unauthorized/i);
  const again = await owner.retrieve(GROUP, up.cid);
  check('O7 the agent (owner) still reads its file', sha256(Buffer.from(again.data)) === sha256(payload));
  check('O8 no write left pending', (await fileStore.load()) === null);

  const after = await rpcBalance(account);
  record.balance_after = after?.toString();
  console.log(`  agent NEAR: ${Number(bal) / 1e24} → ${Number(after) / 1e24} (spent ${(Number(bal! - after!) / 1e24).toFixed(6)})`);
}

main()
  .catch((e) => { check('run completed', false, msg(e)); })
  .finally(() => {
    save();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed — ${OUT}`);
    process.exitCode = failed ? 1 : 0;
  });

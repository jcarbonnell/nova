// aa_native_upload.mjs: D2-0 observation. The Agent Connect agent uploads to NOVA as a MEMBER,
// signing record_transaction ITSELF through Agent API native/near/call (no NOVA signature).
//
//   nova-sdk-js 1.4.0 wallet mode → prepare_upload (MCP) → encrypt locally →
//   walletSigner = native/near/call record_transaction → poll /v1/status → details.tx_hash →
//   [OBSERVE: raw tx from RPC, saved BEFORE finalize] → finalize_upload(tx_hash) (MCP verifies) →
//   retrieve + sha256 → list rows.
//
// Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.grant-token, ./.nova-agent-session):
//   npm i nova-sdk-js@1.4.0
//   node aa_native_upload.mjs
//
// Writes ./observation-native-<ts>.json (public data only) and ./native-upload-state.json (pending
// call: idempotency key, body, correlation id; no secrets). Never prints the API key, grant token or
// NOVA session. A pending call that may have been dispatched blocks any new call: re-running only
// polls it again (Agent Connect rule: UNCERTAIN = keep polling the same id, never resend).

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NovaSdk } from 'nova-sdk-js';

const HERE = process.cwd();
const GROUP = 'loadwallet-readpath-test';
const NOVA_CONTRACT = 'nova-sdk.near';
const ALLOWED_METHOD = 'record_transaction';
const MAX_DEPOSIT = 10n ** 22n; // 0.01 NEAR = the owner's limits.per_transaction for wNEAR
const PENDING = path.join(HERE, 'native-upload-state.json');
const TS = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const OUT = path.join(HERE, `observation-native-${TS}.json`);

const die = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const readJson = (p, d = {}) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const writePrivate = (p, s) => { fs.writeFileSync(p, s, { mode: 0o600 }); fs.chmodSync(p, 0o600); };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const short = (e) => String(e?.message ?? e).slice(0, 300);

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const env = loadEnv();
const API = (env.NEAR_INTENTS_AGENT_API_URL || '').replace(/\/$/, '');
const API_KEY = env.NEAR_INTENTS_AGENT_API_KEY;
const RPC = env.NEAR_RPC_URL || 'https://free.rpc.fastnear.com';
if (!API || !API_KEY) die('NEAR_INTENTS_AGENT_API_URL / NEAR_INTENTS_AGENT_API_KEY missing in .env');
const aa = readJson(path.join(HERE, 'aa-state.json'));
const AGENT_ID = aa.agent_id || die('no agent_id in aa-state.json');
const ACCOUNT = aa.identity_signin?.account_id || die('no signed-in account; run aa_identity.py --signin-native');
const GRANT = fs.readFileSync(path.join(HERE, '.grant-token'), 'utf8').trim();
const SESSION = fs.readFileSync(path.join(HERE, '.nova-agent-session'), 'utf8').trim();
if (!/^ngt_[A-Za-z0-9_-]{43}$/.test(GRANT)) die('.grant-token is not an ngt_ token');

const record = { started_at: new Date().toISOString(), api: API, agent_id: AGENT_ID, account: ACCOUNT,
  group: GROUP, steps: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');

// ── Agent API ────────────────────────────────────────────────────────────────────────────────
async function agentApi(method, p, { body, idem, grant = false, query } = {}) {
  const url = new URL(API + p);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
  const headers = { accept: 'application/json', 'x-api-key': API_KEY };
  if (body) headers['content-type'] = 'application/json';
  if (idem) headers['idempotency-key'] = idem;
  if (grant) headers['x-grant-token'] = GRANT;
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let doc = null;
  try { doc = text ? JSON.parse(text) : null; } catch { doc = { _raw: text.slice(0, 300) }; }
  if (r.status >= 400) {
    const e = doc?.errors?.[0] || {};
    const err = new Error(`${r.status} ${e.code || 'http_error'} [${e.layer || '?'}] ${e.detail || e.title || ''}`);
    Object.assign(err, { status: r.status, code: e.code, layer: e.layer, retryable: !!e.meta?.retryable,
      request_id: doc?.meta?.request_id, errors: doc?.errors });
    throw err;
  }
  return doc;
}

async function pollStatus(cid) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const st = await agentApi('GET', '/v1/status', { query: { correlation_id: cid, wait_ms: 30000 } });
    if (!['PROCESSING', 'QUEUED', 'UNCERTAIN'].includes(st.status)) return st;
    if (Date.now() > deadline) return st;
    console.log(`· ${cid} ${st.status}${st.details?.provider_status ? ` (${st.details.provider_status})` : ''}; polling the same id`);
  }
}

// ── chain ────────────────────────────────────────────────────────────────────────────────────
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'o', method, params }) });
  return r.json();
}
async function balance(account) {
  const r = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
  return r.result ? r.result.amount : null;
}
const decodeArgs = (b64) => { try { return JSON.parse(Buffer.from(b64 || '', 'base64').toString()); } catch { return `<not JSON>`; } };

async function observeTx(txHash, candidates) {
  for (const sender of candidates) {
    const r = await rpc('EXPERIMENTAL_tx_status', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' });
    if (!r.result) continue;
    const res = r.result;
    const tx = res.transaction;
    const fc = (a) => (a && typeof a === 'object' && a.FunctionCall) || null;
    return {
      looked_up_with_sender: sender,
      signer_id: tx.signer_id,
      public_key: tx.public_key,
      receiver_id: tx.receiver_id,
      tx_actions: (tx.actions || []).map((a) => (fc(a)
        ? { FunctionCall: { method_name: fc(a).method_name, args: decodeArgs(fc(a).args), gas: fc(a).gas, deposit: fc(a).deposit } }
        : (typeof a === 'string' ? a : Object.keys(a)[0]))),
      receipts: (res.receipts || []).map((rc) => {
        const acts = rc.receipt?.Action?.actions || [];
        return { receipt_id: rc.receipt_id, predecessor_id: rc.predecessor_id, receiver_id: rc.receiver_id,
          actions: acts.map((a) => (fc(a) ? { FunctionCall: { method_name: fc(a).method_name, deposit: fc(a).deposit } }
            : (typeof a === 'string' ? a : Object.keys(a)[0]))) };
      }),
      tx_outcome: { executor_id: res.transaction_outcome.outcome.executor_id,
        gas_burnt: res.transaction_outcome.outcome.gas_burnt, tokens_burnt: res.transaction_outcome.outcome.tokens_burnt },
      receipt_outcomes: res.receipts_outcome.map((o) => ({ id: o.id, executor_id: o.outcome.executor_id,
        gas_burnt: o.outcome.gas_burnt, tokens_burnt: o.outcome.tokens_burnt, logs: o.outcome.logs,
        status: Object.keys(o.outcome.status)[0] })),
      status: res.status,
    };
  }
  return { unresolved: txHash, tried_senders: candidates };
}

// ── the agent's signer: Agent API native/near/call ──────────────────────────────────────────
const agentSigner = {
  accountId: ACCOUNT,
  async signAndSendFunctionCall(call) {
    if (call.receiverId !== NOVA_CONTRACT) throw new Error(`refusing: receiver ${call.receiverId}`);
    if (call.methodName !== ALLOWED_METHOD) throw new Error(`refusing: method ${call.methodName} (D2-0 records only)`);
    if (call.deposit > MAX_DEPOSIT) throw new Error(`refusing: deposit ${call.deposit} > owner cap ${MAX_DEPOSIT}`);
    const body = { receiver_id: call.receiverId, method_name: call.methodName, args: call.args,
      gas: call.gas.toString(), deposit: call.deposit.toString() };
    const pending = { idempotency_key: `nova-d20-${randomUUID()}`, body, at: new Date().toISOString() };
    writePrivate(PENDING, JSON.stringify(pending, null, 2) + '\n'); // key + body persisted BEFORE sending
    record.steps.native_call_request = body;
    record.balance_before = await balance(ACCOUNT);

    let st;
    try {
      st = await agentApi('POST', `/v1/agents/${AGENT_ID}/native/near/call`, { body, idem: pending.idempotency_key, grant: true });
    } catch (e) {
      record.steps.native_call_error = { message: short(e), status: e.status, code: e.code, layer: e.layer,
        retryable: e.retryable, request_id: e.request_id, errors: e.errors };
      save();
      if (e.status && e.status < 500) fs.rmSync(PENDING); // 4xx incl. 429 rate_limited: a proven refusal, nothing sent
      throw e;
    }
    pending.correlation_id = st.correlation_id;
    writePrivate(PENDING, JSON.stringify(pending, null, 2) + '\n');
    record.steps.native_call_202 = st;
    console.log(`✓ native/near/call accepted: ${st.correlation_id} ${st.status}`);

    const fin = st.status === 'SUCCESS' ? st : await pollStatus(st.correlation_id);
    record.steps.native_call_final = fin;
    save();
    if (fin.status === 'NEEDS_REVIEW') throw new Error(`NEEDS_REVIEW (${fin.details?.failure_reason}); stop, do not retry`);
    if (fin.status !== 'SUCCESS') throw new Error(`native call ended ${fin.status} failure_code=${fin.failure_code} reason=${fin.details?.failure_reason}`);
    const txHash = fin.details?.tx_hash;
    if (!txHash) throw new Error('SUCCESS without details.tx_hash');
    fs.rmSync(PENDING);

    // OBSERVE before finalize, whatever finalize does next.
    record.chain_tx = await observeTx(txHash, [...new Set([ACCOUNT, fin.details?.account_id, 'outlayer.near'].filter(Boolean))]);
    record.balance_after = await balance(ACCOUNT);
    save();
    console.log(`✓ tx ${txHash}: signer_id=${record.chain_tx.signer_id ?? '?'} ` +
      `receiver=${record.chain_tx.receiver_id ?? '?'} (signer == agent account: ${record.chain_tx.signer_id === ACCOUNT})`);
    console.log(`  agent NEAR balance ${record.balance_before} → ${record.balance_after} yocto`);
    return { txHash };
  },
};

// ── run ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const pending = readJson(PENDING, null);
  if (pending) {
    if (!pending.correlation_id) die(`${PENDING} holds a call with no correlation id (maybe sent): inspect, tell Claude; do not delete blindly`);
    console.log(`· resuming the pending call ${pending.correlation_id}: polling only, nothing is resent`);
    const fin = await pollStatus(pending.correlation_id);
    record.steps.resumed_final = fin;
    if (fin.details?.tx_hash) record.chain_tx = await observeTx(fin.details.tx_hash, [ACCOUNT, 'outlayer.near']);
    save();
    die(`pending call is ${fin.status}; observation saved to ${OUT}. Its upload_id has expired: tell Claude before any new run`);
  }

  const sdk = new NovaSdk(ACCOUNT, { sessionToken: SESSION, walletSigner: agentSigner });
  console.log(`agent ${AGENT_ID}\naccount ${ACCOUNT} (signer mode: ${sdk.signerMode})\ngroup ${GROUP}`);
  if (sdk.signerMode !== 'wallet') die('SDK is not in wallet mode');
  if (!(await sdk.isAuthorized(GROUP, ACCOUNT))) die(`agent is not a member of ${GROUP}; run: node aa_readpath.mjs readd`);

  const payload = Buffer.from(JSON.stringify({
    kind: 'd2-0-observation', note: 'agent self-signed record via Agent Connect native/near/call',
    account: ACCOUNT, captured_at: new Date().toISOString(),
  }));
  const localHash = sha256(payload);
  record.plaintext_sha256 = localHash;

  let up;
  try {
    up = await sdk.upload(GROUP, payload, `d2-0-native-${TS}.json`);
    record.steps.finalize = { ok: true, ...up };
    console.log(`✓ finalize accepted by MCP: location ${up.cid}, trans_id ${String(up.trans_id).replace(/"/g, '')}`);
  } catch (e) {
    record.steps.finalize = { ok: false, error: short(e) };
    save();
    die(`upload stopped: ${short(e)}\n  observation saved to ${OUT} (send it to Claude)`);
  }

  try {
    const { data } = await sdk.retrieve(GROUP, up.cid);
    const h = sha256(Buffer.from(data));
    record.steps.retrieve = { bytes: Buffer.from(data).length, sha256_matches: h === localHash };
    console.log(`${h === localHash ? '✓' : '✗'} retrieved ${Buffer.from(data).length} bytes, sha256 ${h === localHash ? 'matches' : 'DIFFERS'}`);
  } catch (e) {
    record.steps.retrieve = { error: short(e) };
    console.log(`✗ retrieve failed: ${short(e)}`);
  }
  try {
    const rows = await sdk.getTransactionsForGroup(GROUP);
    const row = rows.find((r) => r.ipfs_hash === up.cid);
    record.steps.row = row || null;
    console.log(`${row ? '✓' : '✗'} on-chain row ${row ? `found: user_id=${row.user_id}, file_hash ${row.file_hash === localHash ? 'matches' : 'DIFFERS'}` : 'MISSING'}`);
  } catch (e) {
    record.steps.row = { error: short(e) };
    console.log(`✗ listing failed: ${short(e)}`);
  }
  save();
  console.log(`✓ wrote ${OUT}`);
}

main().catch((e) => { save(); die(`${short(e)}\n  observation saved to ${OUT}`); });

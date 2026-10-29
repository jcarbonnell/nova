// test-nova-agent-connect.ts: offline harness for nova-agent-connect.ts.
// Real module, real @near-intents-agent-api/sdk 0.7.2 client and real nova-sdk-js 1.4.0, with the
// Agent API and NOVA mocked behind the client's injected `fetch`. Each refusal is asserted by its
// specific message. NAC_MODULE=<path> runs it against a mutant (see mutate-nova-agent-connect.mjs).
//
//   npx tsx test-nova-agent-connect.ts

import { createAgentApi } from '@near-intents-agent-api/sdk';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const modPath = process.env.NAC_MODULE ?? './nova-agent-connect.ts';
const M: typeof import('./nova-agent-connect.ts') = await import(pathToFileURL(path.resolve(modPath)).href);

const API_KEY = 'naa_' + 'A'.repeat(43);
const GRANT = 'ngt_' + 'B'.repeat(43);
const AGENT = 'agent-1';
const ACCOUNT = '5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288';
const TX = '2GZEEVjiLZL9SBTH3VBvmFD37mEkh7NoH16iotrg1sYj';
const NOVA = 'https://nova.test';

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); }
  console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? ` — ${extra}` : ''}`);
}
async function rejects(fn: () => Promise<unknown>, re: RegExp): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return re.test(String((e as Error).message)) ? (e as Error) : null; }
}

// ── fake network ──────────────────────────────────────────────────────────────────────────────
type Reply = { status: number; body: unknown } | 'throw';
interface Req { url: URL; method: string; headers: Headers; body: any }
class Net {
  reqs: Req[] = [];
  callReplies: Reply[] = [];
  statusReplies: Reply[] = [];
  onCall?: (r: Req) => Promise<void> | void;
  nova = {
    challenge: { status: 200, body: { challenge: 'c1', message: 'MSG', audience: 'nova-sdk.near', nonce: 'N'.repeat(43) + '=', expires_at_ms: 1 } } as Reply,
    verify: { status: 200, body: { token: 'session.jwt', account_id: ACCOUNT, expires_in: 3600 } } as Reply,
  };
  agentWallet: string | null = ACCOUNT;
  signAccount = ACCOUNT;
  fetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const req: Req = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null };
    this.reqs.push(req);
    const send = (r: Reply) => {
      if (r === 'throw') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    };
    const p = url.pathname;
    if (url.origin === NOVA) {
      if (p === '/api/auth/agent-identity/challenge') return send(this.nova.challenge);
      if (p === '/api/auth/agent-identity/verify') return send(this.nova.verify);
    }
    if (p === `/v1/agents/${AGENT}/native/near/call`) {
      if (this.onCall) await this.onCall(req);
      return send(this.callReplies.shift() ?? { status: 500, body: err('no_reply', 'api', 500) });
    }
    if (p === '/v1/status') return send(this.statusReplies.shift() ?? { status: 500, body: err('no_reply', 'api', 500) });
    if (p === `/v1/agents/${AGENT}/native/near/sign-message`) {
      return send({ status: 200, body: { correlation_id: 'op_s', near_account_id: this.signAccount, public_key: 'ed25519:K',
        signature: 'S'.repeat(86) + '==', nonce: req.body.nonce, recipient: req.body.recipient } });
    }
    if (p === `/v1/agents/${AGENT}`) {
      return send({ status: 200, body: { id: AGENT, wallet: this.agentWallet ? { wallet_id: 'w', near_account_id: this.agentWallet, evm_account_id: null, solana_account_id: null } : null } });
    }
    return send({ status: 404, body: err('not_found', 'request', 404) });
  };
  calls() { return this.reqs.filter((r) => r.url.pathname.endsWith('/native/near/call')); }
}
function err(code: string, layer: string, status: number, retryable?: boolean) {
  return { errors: [{ status: String(status), code, layer, title: code, detail: `${code} detail`, ...(retryable !== undefined ? { meta: { retryable } } : {}) }] };
}
function st(status: string, extra: Record<string, unknown> = {}, txHash: string | null = TX) {
  return { status: 202, body: statusDoc(status, extra, txHash) };
}
function statusDoc(status: string, extra: Record<string, unknown> = {}, txHash: string | null = TX) {
  return { correlation_id: 'op_1', agent_id: AGENT, type: 'native', status, failure_code: null, created_at: '', updated_at: '',
    dispatch_committed_at: null, grant: null, ...extra,
    details: { method: 'near_call', chain: 'near', account_id: ACCOUNT, target: 'nova-sdk.near', amount: '0', method_name: 'record_transaction',
      primary_type: null, domain: null, message_json: null, request_sha256: 'x', signature: null, tx_hash: txHash,
      provider_request_id: null, provider_status: null, failure_reason: status === 'FAILED' ? 'Smart contract panicked: not a member' : null } };
}
function setup(opts: Partial<{ cap: bigint; deadline: number }> = {}) {
  const net = new Net();
  const api = createAgentApi({ apiKey: API_KEY, baseUrl: 'https://api.test', fetch: net.fetch as typeof fetch }).forGrant(GRANT);
  const store = M.memoryStore();
  const signer = M.agentConnectSigner(api, AGENT, ACCOUNT, { store, maxDepositYocto: opts.cap ?? 10n ** 22n, pollDeadlineMs: opts.deadline ?? 50 });
  return { net, api, store, signer };
}
const CALL = {
  receiverId: 'nova-sdk.near', methodName: 'record_transaction',
  args: { group_id: 'g', user_id: ACCOUNT, file_hash: 'f'.repeat(64), ipfs_hash: 'loc', backend: 'FastFS' },
  gas: 100_000_000_000_000n, deposit: 25_600_000_000_000_000_000n,
};

// ── novaPolicyPatch ───────────────────────────────────────────────────────────────────────────
{
  const base: any = {
    frozen: false, actions: ['withdraw'], confidential: false, owner_approval: false,
    assets: ['nep141:usdc'], limits: { per_transaction: { 'nep141:usdc': '200000' } }, max_actions_per_hour: 5,
    destinations: { mode: 'only', list: [] }, budget: { daily_usd: '1', weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    native: { near: { sign_message: [], transfer: false, call: [] },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false }, solana: { sign_message: false, sign_transaction: false } },
  };
  const snapshot = JSON.stringify(base);
  const out: any = M.novaPolicyPatch(base, { maxDepositYocto: 10n ** 22n });
  ok('P1 call and sign_message list nova-sdk.near', JSON.stringify(out.native.near.call) === '["nova-sdk.near"]' && JSON.stringify(out.native.near.sign_message) === '["nova-sdk.near"]');
  ok('P2 assets gain wrap.near, wNEAR cap set, USDC cap kept', out.assets.includes('nep141:wrap.near') &&
    out.limits.per_transaction['nep141:wrap.near'] === '10000000000000000000000' && out.limits.per_transaction['nep141:usdc'] === '200000');
  ok('P3 input not mutated', JSON.stringify(base) === snapshot);
  const twice: any = M.novaPolicyPatch(out, { maxDepositYocto: 10n ** 22n });
  ok('P4 idempotent (no duplicate entries)', JSON.stringify(twice) === JSON.stringify(out));
  ok('P5 transfer, EVM, Solana and every other field unchanged', out.native.near.transfer === false &&
    JSON.stringify(out.native.evm) === JSON.stringify(base.native.evm) && JSON.stringify(out.native.solana) === JSON.stringify(base.native.solana) &&
    JSON.stringify({ ...out, native: 0, assets: 0, limits: 0 }) === JSON.stringify({ ...base, native: 0, assets: 0, limits: 0 }));
  const anyAssets: any = M.novaPolicyPatch({ ...base, assets: 'any' }, { maxDepositYocto: 1n });
  ok('P6 assets "any" stays "any"', anyAssets.assets === 'any');
  const { native: _drop, ...noNative } = base;
  const fresh: any = M.novaPolicyPatch(noNative, { maxDepositYocto: 1n });
  ok('P7 missing native → everything off except the NOVA lists', fresh.native.near.transfer === false && fresh.native.evm.sign_message === false &&
    fresh.native.evm.sign_transaction === false && fresh.native.solana.sign_transaction === false && fresh.native.near.call[0] === 'nova-sdk.near');
  let threw = false;
  try { M.novaPolicyPatch(base, { maxDepositYocto: 0n }); } catch (e) { threw = /maxDepositYocto must be > 0/.test(String(e)); }
  ok('P8 zero cap refused', threw);
}

// ── signer: refusals before anything is sent ─────────────────────────────────────────────────
{
  const { net, signer } = setup();
  ok('S1 another receiver refused, nothing sent', !!(await rejects(() => signer.signAndSendFunctionCall({ ...CALL, receiverId: 'wrap.near' }), /receiver wrap\.near is not nova-sdk\.near/)) && net.calls().length === 0);
  ok('S2 a non-NOVA method refused, nothing sent', !!(await rejects(() => signer.signAndSendFunctionCall({ ...CALL, methodName: 'ft_transfer' }), /ft_transfer is not a NOVA write method/)) && net.calls().length === 0);
  ok('S3 deposit above the cap refused, nothing sent', !!(await rejects(() => signer.signAndSendFunctionCall({ ...CALL, deposit: 10n ** 22n + 1n }), /exceeds the cap/)) && net.calls().length === 0);
}

// ── signer: happy paths ──────────────────────────────────────────────────────────────────────
{
  const { net, store, signer } = setup();
  let savedAtSend: any = 'unset';
  net.onCall = async (r) => { savedAtSend = { stored: await store.load(), header: r.headers.get('idempotency-key') }; };
  net.callReplies.push(st('SUCCESS'));
  const r = await signer.signAndSendFunctionCall({ ...CALL, deposit: 10n ** 22n }) // deposit == cap is allowed
    .catch((e) => ({ txHash: `refused: ${e.message}` }));
  const req = net.calls()[0] ?? { body: null, headers: new Headers() };
  ok('S4 SUCCESS at 202 → tx hash, deposit equal to the cap accepted', r.txHash === TX);
  ok('S5 body is exactly the SDK call (gas and deposit as strings)', JSON.stringify(req.body) === JSON.stringify({
    receiver_id: 'nova-sdk.near', method_name: 'record_transaction', args: CALL.args, gas: '100000000000000', deposit: '10000000000000000000000' }));
  ok('S6 grant and idempotency key sent to the Agent API', req.headers.get('x-grant-token') === GRANT && /^nova-[0-9a-f-]{36}$/.test(req.headers.get('idempotency-key') ?? ''));
  ok('S7 key and body persisted BEFORE the request', savedAtSend?.stored?.idempotencyKey === savedAtSend?.header && savedAtSend?.stored?.body?.method_name === 'record_transaction');
  ok('S8 store cleared after SUCCESS', (await store.load()) === null);
}
{
  const { net, signer } = setup();
  net.callReplies.push(st('PROCESSING'));
  net.statusReplies.push({ status: 200, body: statusDoc('PROCESSING') }, { status: 200, body: statusDoc('SUCCESS') });
  const r = await signer.signAndSendFunctionCall(CALL);
  const polls = net.reqs.filter((q) => q.url.pathname === '/v1/status');
  ok('S9 PROCESSING → polled the same id → tx hash', r.txHash === TX && polls.length === 2 && polls.every((q) => q.url.searchParams.get('correlation_id') === 'op_1'));
}

// ── signer: unsettled, refused, failed ───────────────────────────────────────────────────────
{
  const { net, store, signer } = setup({ deadline: 0 });
  net.callReplies.push(st('UNCERTAIN'));
  net.statusReplies.push({ status: 200, body: statusDoc('UNCERTAIN') });
  const e = await rejects(() => signer.signAndSendFunctionCall(CALL), /is not settled \(UNCERTAIN\)/);
  const kept = await store.load();
  ok('S10 UNCERTAIN past the deadline → NativeCallPendingError, call kept with its id', !!e && e instanceof M.NativeCallPendingError && kept?.correlationId === 'op_1');
  ok('S11 a new write is refused while one is pending, nothing sent', !!(await rejects(() => signer.signAndSendFunctionCall(CALL), /is pending: call resolvePending\(\) first/)) && net.calls().length === 1);
  net.statusReplies.push({ status: 200, body: statusDoc('SUCCESS') });
  const res = await signer.resolvePending();
  ok('S12 resolvePending polls the same id (no resend) → SUCCESS + tx hash, store cleared',
    res?.status === 'SUCCESS' && res.txHash === TX && net.calls().length === 1 && (await store.load()) === null);
  ok('S13 resolvePending with nothing pending → null', (await signer.resolvePending()) === null);
}
{
  const { net, store, signer } = setup();
  net.callReplies.push({ status: 403, body: err('native_method_denied', 'policy', 403) });
  const e = await rejects(() => signer.signAndSendFunctionCall(CALL), /Agent API refused record_transaction: 403 native_method_denied \[policy\]/);
  ok('S14 403 refusal → its code and layer, store cleared (nothing was sent)', !!e && !(e instanceof M.NativeCallPendingError) && (await store.load()) === null);
  net.callReplies.push(st('SUCCESS'));
  ok('S15 after a refusal the next write goes through', (await signer.signAndSendFunctionCall(CALL)).txHash === TX);
}
{
  const { net, store, signer } = setup();
  net.callReplies.push({ status: 429, body: err('rate_limited', 'api', 429, true) });
  const e = await rejects(() => signer.signAndSendFunctionCall(CALL), /is not settled/);
  const kept = await store.load();
  ok('S16 retryable 429 → pending kept (same key later)', !!e && !!kept && !kept.correlationId);
  net.callReplies.push(st('SUCCESS'));
  const res = await signer.resolvePending();
  const [a, b] = net.calls();
  ok('S17 resolvePending replays the SAME key and body', res?.status === 'SUCCESS' && a.headers.get('idempotency-key') === b.headers.get('idempotency-key') &&
    JSON.stringify(a.body) === JSON.stringify(b.body));
}
{
  const { net, store, signer } = setup();
  net.callReplies.push({ status: 500, body: err('internal_error', 'api', 500, true) });
  ok('S18 500 → pending kept', !!(await rejects(() => signer.signAndSendFunctionCall(CALL), /is not settled/)) && !!(await store.load()));
  net.callReplies.push({ status: 403, body: err('native_contract_forbidden', 'policy', 403) });
  ok('S19 a replay refused with 403 clears the call', !!(await rejects(() => signer.resolvePending(), /403 native_contract_forbidden/)) && (await store.load()) === null);
}
{
  const { net, store, signer } = setup();
  net.callReplies.push('throw');
  ok('S20 transport failure → pending kept', !!(await rejects(() => signer.signAndSendFunctionCall(CALL), /is not settled/)) && !!(await store.load()));
}
{
  const { net, store, signer } = setup();
  net.callReplies.push(st('NEEDS_REVIEW'));
  const e = await rejects(() => signer.signAndSendFunctionCall(CALL), /NEEDS_REVIEW/);
  ok('S21 NEEDS_REVIEW → stops, call kept for inspection', !!e && (await store.load())?.correlationId === 'op_1');
}
{
  const { net, store, signer } = setup();
  net.callReplies.push(st('FAILED', { failure_code: 'provider_failed' }));
  ok('S22 FAILED → its code and reason, store cleared',
    !!(await rejects(() => signer.signAndSendFunctionCall(CALL), /record_transaction ended FAILED \(provider_failed\): Smart contract panicked: not a member/)) && (await store.load()) === null);
  net.callReplies.push(st('SUCCESS', {}, null));
  ok('S23 SUCCESS without a tx hash refused', !!(await rejects(() => signer.signAndSendFunctionCall(CALL), /succeeded without a transaction hash/)));
}

{
  // The integrator's client may come from ANOTHER copy of the Agent API SDK than the module's.
  const net = new Net();
  const store = M.memoryStore();
  class AgentApiError extends Error {           // a second, unrelated class with the SDK's shape
    name = 'AgentApiError'; status = 403; code = 'native_method_denied'; layer = 'policy'; detail = 'd'; retryable = false;
  }
  const foreign = { nativeNearCall: async () => { throw new AgentApiError('403'); }, getStatus: async () => { throw new Error('unused'); } };
  const signer = M.agentConnectSigner(foreign as any, AGENT, ACCOUNT, { store, maxDepositYocto: 10n ** 22n });
  const e = await rejects(() => signer.signAndSendFunctionCall(CALL), /Agent API refused record_transaction: 403 native_method_denied \[policy\]/);
  ok('S24 a refusal from another SDK copy is still a refusal (store cleared)', !!e && (await store.load()) === null);
  void net;
}

// ── sign-in ──────────────────────────────────────────────────────────────────────────────────
{
  const { net, api } = setup();
  const s = await M.signInAgent(api, AGENT, { novaUrl: NOVA, fetch: net.fetch as typeof fetch });
  const signReq = net.reqs.find((q) => q.url.pathname.endsWith('/sign-message'))!;
  const verifyReq = net.reqs.find((q) => q.url.pathname.endsWith('/verify'))!;
  ok('I1 NOVA message, audience and nonce signed verbatim', signReq.body.message === 'MSG' && signReq.body.recipient === 'nova-sdk.near' && signReq.body.nonce === 'N'.repeat(43) + '=');
  ok('I2 verify gets the challenge + exactly five signature fields', verifyReq.body.challenge === 'c1' &&
    JSON.stringify(Object.keys(verifyReq.body.signature).sort()) === JSON.stringify(['near_account_id', 'nonce', 'public_key', 'recipient', 'signature']));
  ok('I3 session returned for the signing account', s.token === 'session.jwt' && s.accountId === ACCOUNT && s.expiresIn === 3600);
  const novaReqs = net.reqs.filter((q) => q.url.origin === NOVA);
  const leak = novaReqs.some((q) => JSON.stringify(q.body ?? {}).match(/naa_|ngt_/) || [...q.headers.values()].some((v) => /naa_|ngt_/.test(v)));
  ok('I4 neither naa_ nor ngt_ ever reaches NOVA', novaReqs.length === 2 && !leak);
}
{
  const { net, api } = setup();
  net.nova.challenge = { status: 200, body: { challenge: 'c1', message: 'MSG', audience: 'nova-sdk.near', expires_at_ms: 1 } };
  ok('I5 challenge without a nonce refused, nothing signed', !!(await rejects(() => M.signInAgent(api, AGENT, { novaUrl: NOVA, fetch: net.fetch as typeof fetch }), /missing message, audience or nonce/)) &&
    !net.reqs.some((q) => q.url.pathname.endsWith('/sign-message')));
}
{
  const { net, api } = setup();
  net.nova.verify = { status: 200, body: { token: 't', account_id: 'someone-else.near' } };
  ok('I6 session for another account refused', !!(await rejects(() => M.signInAgent(api, AGENT, { novaUrl: NOVA, fetch: net.fetch as typeof fetch }), /no session for the signing account/)));
}
{
  const { net, api } = setup();
  net.nova.verify = { status: 401, body: { code: 'UNAUTHORIZED_NONCE_REPLAY' } };
  ok('I7 NOVA refusal surfaces its code', !!(await rejects(() => M.signInAgent(api, AGENT, { novaUrl: NOVA, fetch: net.fetch as typeof fetch }), /verify refused: 401 UNAUTHORIZED_NONCE_REPLAY/)));
}

// ── connect ──────────────────────────────────────────────────────────────────────────────────
{
  const { net, api } = setup();
  const c = await M.connectNovaAgent(api, AGENT, { store: M.memoryStore(), maxDepositYocto: 10n ** 22n, novaUrl: NOVA, fetch: net.fetch as typeof fetch });
  ok('C1 NovaSdk in wallet mode for the agent account, signer exposed', c.nova.signerMode === 'wallet' && c.accountId === ACCOUNT &&
    c.signer.accountId === ACCOUNT && typeof c.signer.resolvePending === 'function' && c.sessionExpiresIn === 3600);
  ok('C2 contract is nova-sdk.near', c.nova.getNetworkInfo().contractId === 'nova-sdk.near');
}
{
  const { net, api } = setup();
  net.signAccount = 'other.near';
  net.nova.verify = { status: 200, body: { token: 't', account_id: 'other.near' } };
  ok('C3 session account ≠ agent wallet refused', !!(await rejects(() => M.connectNovaAgent(api, AGENT, { store: M.memoryStore(), maxDepositYocto: 1n, novaUrl: NOVA, fetch: net.fetch as typeof fetch }), /differs from the agent wallet/)));
}
{
  const { net, api } = setup();
  net.agentWallet = null;
  ok('C4 agent without a NEAR account refused before sign-in', !!(await rejects(() => M.connectNovaAgent(api, AGENT, { store: M.memoryStore(), maxDepositYocto: 1n, novaUrl: NOVA, fetch: net.fetch as typeof fetch }), /has no NEAR account yet/)) &&
    !net.reqs.some((q) => q.url.origin === NOVA));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { console.log('failed:\n  ' + failures.join('\n  ')); process.exit(1); }

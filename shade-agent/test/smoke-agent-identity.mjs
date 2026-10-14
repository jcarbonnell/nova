// shade-agent/test/smoke-agent-identity.mjs
//
// PRODUCTION SMOKE for the Agent Connect identity bridge, after deploying
// Shade + MCP v0.4.5 + nova-landing. Order: health → security invariants →
// happy path → SDK path (MCP accepts the minted session).
//
// Simulates the Agent API locally: a FRESH throwaway key (implicit account, not
// on chain, never funded) signs NOVA's challenge with near-kit, exactly as
// api.sign would. No real secret is used or shown. The only on-chain effect is
// get_member_groups: MCP's reader key signs one gas-only read call (as it does
// for every wallet-tier listing).
//
// RUN (from shade-agent/):
//   node test/smoke-agent-identity.mjs
//   (override: FRONTEND=https://nova-sdk.com MCP=https://…-8000.dstack-prod5.phala.network)

import { randomBytes } from 'node:crypto';
import { Near, InMemoryKeyStore, generateKey } from 'near-kit';

const FRONTEND = process.env.FRONTEND || 'https://nova-sdk.com';
const MCP = process.env.MCP || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${!cond && extra ? '\n       ' + extra : ''}`);
  cond ? pass++ : fail++;
};
async function call(url, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const redact = (s) => String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>');

// The simulated agent: fresh implicit account.
const kp = generateKey();
const accountId = Buffer.from(kp.publicKey.data).toString('hex');
const near = new Near({ network: 'mainnet', keyStore: new InMemoryKeyStore({ [accountId]: kp.secretKey }), defaultSignerId: accountId });
async function apiSign(message, recipient, nonce = randomBytes(32)) {
  const sm = await near.signMessage({ message, recipient, nonce }, { signerId: accountId });
  return {
    near_account_id: accountId, public_key: sm.publicKey,
    signature: Buffer.from(sm.signature, 'base64').toString('hex'),
    nonce: nonce.toString('base64'), recipient,
  };
}

console.log(`\nAgent identity smoke — ${FRONTEND} / MCP\n  agent (implicit, throwaway): ${accountId.slice(0, 12)}…\n`);

console.log('1. Health:');
{
  const h = await call(`${MCP}/health`, { method: 'GET' });
  check('MCP /health reports 0.4.5', h.status === 200 && h.json?.version === '0.4.5', h.text);
}

console.log('\n2. Security invariants:');
{
  const r = await call(`${MCP}/tools/get_member_groups`, { body: {} });
  check('MCP without credentials → 401', r.status === 401, `${r.status} ${redact(r.text)}`);
  const v = await call(`${FRONTEND}/api/auth/agent-identity/verify`, {
    body: { challenge: 'ab'.repeat(32), signature: await apiSign('x', 'nova-sdk.near') },
  });
  check('never-issued challenge → 401 UNAUTHORIZED_NONCE_REPLAY, no token',
    v.status === 401 && v.json?.code === 'UNAUTHORIZED_NONCE_REPLAY' && !v.json?.token, `${v.status} ${redact(v.text)}`);
}

console.log('\n3. Happy path:');
let token;
{
  const c = await call(`${FRONTEND}/api/auth/agent-identity/challenge`, { body: {} });
  const env = c.json?.message ? JSON.parse(c.json.message) : null;
  check('challenge → 200, 7-field envelope, audience nova-sdk.near, 120 s',
    c.status === 200 && env && Object.keys(env).length === 7 && env.audience === 'nova-sdk.near'
      && env.expires_at_ms - env.issued_at_ms === 120_000, `${c.status} ${c.text}`);

  // Wrong recipient first: refused, and must not burn the challenge.
  const wrong = await call(`${FRONTEND}/api/auth/agent-identity/verify`, {
    body: { challenge: c.json.challenge, signature: await apiSign(c.json.message, 'other.near') },
  });
  check('signature for another recipient → 401 UNAUTHORIZED', wrong.status === 401 && wrong.json?.code === 'UNAUTHORIZED', `${wrong.status} ${redact(wrong.text)}`);

  const sig = await apiSign(c.json.message, c.json.audience);
  const v = await call(`${FRONTEND}/api/auth/agent-identity/verify`, { body: { challenge: c.json.challenge, signature: sig } });
  token = v.json?.token;
  check('valid signature (same challenge, after the refusal) → 200 + token for the implicit account',
    v.status === 200 && typeof token === 'string' && v.json?.account_id === accountId, `${v.status} ${redact(v.text)}`);

  const replay = await call(`${FRONTEND}/api/auth/agent-identity/verify`, { body: { challenge: c.json.challenge, signature: sig } });
  check('replay of the same signature → 401 UNAUTHORIZED_NONCE_REPLAY', replay.status === 401 && replay.json?.code === 'UNAUTHORIZED_NONCE_REPLAY', `${replay.status} ${redact(replay.text)}`);
}

console.log('\n4. SDK path (MCP accepts the session):');
if (token) {
  const auth = { Authorization: `Bearer ${token}` };
  const s = await call(`${MCP}/tools/auth_status`, { body: { group_id: 'default' }, headers: auth });
  check('auth_status → authenticated as the implicit account (no suffix appended)',
    s.status === 200 && s.json?.result?.near_account_id === accountId, `${s.status} ${redact(s.text)}`);
  const g = await call(`${MCP}/tools/get_member_groups`, { body: {}, headers: auth });
  check('get_member_groups → 200 [] (wallet tier, reader view)', g.status === 200 && Array.isArray(g.json?.result) && g.json.result.length === 0, `${g.status} ${redact(g.text)}`);
} else {
  check('SDK path skipped — no token from step 3', false);
}

console.log(`\n${'─'.repeat(60)}\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

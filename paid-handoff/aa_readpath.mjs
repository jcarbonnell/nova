// aa_readpath.mjs: Harry's (LoadWallet) read path, end to end, on mainnet.
//
//   A custodial NOVA account (the payer's backend, API key) owns a group, adds the Agent
//   Connect agent as a member and uploads a proof. The agent, signed in with its OWN identity
//   (native/near/sign-message → NOVA session, see aa_identity.py --signin-native), retrieves
//   and decrypts it through nova-sdk-js's `sessionToken` option, and checks the fingerprint.
//
// Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.nova-agent-session):
//   npm i nova-sdk-js@^1.2.5
//   node aa_readpath.mjs setup    # owner: register group, add agent, upload a proof   (~0.69 NEAR)
//   node aa_readpath.mjs read     # agent: retrieve + verify; try to list files (known gap)
//   node aa_readpath.mjs revoke   # owner: revoke the agent; then the agent's retrieve MUST fail
//   node aa_readpath.mjs readd    # owner: add the agent back (~0.013 NEAR)
//   node aa_readpath.mjs list     # agent: list the group's files (MCP v40 + contract v0.3.7)
//   node aa_readpath.mjs agent-upload   # agent: try to upload — MCP v40 must refuse it, nothing written
//
// Never prints the API key or the session token. Writes ./readpath-state.json (no secrets).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NovaSdk } from 'nova-sdk-js';

const HERE = process.cwd();
const GROUP = 'loadwallet-readpath-test';
const STATE = path.join(HERE, 'readpath-state.json');

function die(msg) { console.error(`✗ ${msg}`); process.exit(1); }
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(HERE, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const readJson = (p, d = {}) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const saveState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const short = (e) => String(e?.message ?? e).slice(0, 240);

const env = loadEnv();
if (!env.NOVA_ACCOUNT_ID || !env.NOVA_API_KEY) die('NOVA_ACCOUNT_ID / NOVA_API_KEY missing in .env');
const aa = readJson(path.join(HERE, 'aa-state.json'));
const agentAccount = aa.identity_signin?.account_id;
if (!agentAccount) die('no signed-in agent account in aa-state.json; run aa_identity.py --signin-native');

function ownerSdk() {
  return new NovaSdk(env.NOVA_ACCOUNT_ID, { apiKey: env.NOVA_API_KEY });
}
function agentSdk() {
  const f = path.join(HERE, '.nova-agent-session');
  if (!fs.existsSync(f)) die('.nova-agent-session missing; run aa_identity.py --signin-native');
  return new NovaSdk(agentAccount, { sessionToken: fs.readFileSync(f, 'utf8').trim() });
}

async function setup() {
  const owner = ownerSdk();
  const state = readJson(STATE);
  console.log(`owner ${env.NOVA_ACCOUNT_ID}, agent ${agentAccount}, group ${GROUP}`);
  console.log(`owner balance: ${await owner.getBalance()}`);

  let exists = false;
  try { exists = (await owner.getGroupOwner(GROUP)) === env.NOVA_ACCOUNT_ID; } catch { exists = false; }
  if (!exists) {
    await owner.registerGroup(GROUP);
    console.log(`✓ group ${GROUP} registered`);
  } else console.log(`· group ${GROUP} already exists (owned by us)`);

  if (!(await owner.isAuthorized(GROUP, agentAccount))) {
    await owner.addGroupMember(GROUP, agentAccount);
    console.log(`✓ agent added as member`);
  } else console.log('· agent already a member');
  console.log(`  is_authorized(agent) = ${await owner.isAuthorized(GROUP, agentAccount)}`);

  const proof = Buffer.from(JSON.stringify({
    order_id: 'demo-123', kind: 'delivery-proof', note: 'simulated proof for the NOVA x LoadWallet read path',
    captured_at: new Date().toISOString(),
  }));
  const up = await owner.upload(GROUP, proof, 'order-demo-123.json');
  const local = sha256(proof);
  console.log(`✓ uploaded: trans_id ${String(up.trans_id).replace(/"/g, '')}`);
  console.log(`  location ${up.cid}`);
  console.log(`  file_hash ${up.file_hash} (local sha256 matches: ${up.file_hash === local})`);
  state.group = GROUP;
  state.upload = { location: up.cid, trans_id: String(up.trans_id).replace(/"/g, ''), file_hash: up.file_hash };
  saveState(state);
  console.log(`  owner balance after: ${await owner.getBalance()}`);
}

async function read({ expectFailure = false } = {}) {
  const state = readJson(STATE);
  if (!state.upload) die('run setup first');
  const agent = agentSdk();

  try {
    const st = await agent.authStatus(GROUP);
    console.log(`· agent auth_status: ${JSON.stringify(st)}`);
  } catch (e) { console.log(`· agent auth_status failed: ${short(e)}`); }

  let ok = false;
  try {
    const { data } = await agent.retrieve(GROUP, state.upload.location);
    const h = sha256(Buffer.from(data));
    ok = h === state.upload.file_hash;
    console.log(`${ok ? '✓' : '✗'} agent retrieved + decrypted ${Buffer.from(data).length} bytes; ` +
      `sha256 ${ok ? 'matches' : 'DOES NOT match'} the on-chain file_hash`);
    if (ok && !expectFailure) console.log(`  content: ${Buffer.from(data).toString('utf8').slice(0, 160)}`);
  } catch (e) {
    console.log(`${expectFailure ? '✓' : '✗'} agent retrieve failed: ${short(e)}`);
  }
  if (expectFailure && ok) console.log('✗ SECURITY: a revoked member could still retrieve');

  if (!expectFailure) {
    try {
      const rows = await agent.getTransactionsForGroup(GROUP);
      console.log(`! agent listed the private group's files (${rows.length} rows) — gap already closed?`);
    } catch (e) {
      console.log(`· agent cannot list the private group's files yet (known gap → contract v0.3.7 + MCP): ${short(e)}`);
    }
  }
}

async function revoke() {
  const owner = ownerSdk();
  if (await owner.isAuthorized(GROUP, agentAccount)) {
    await owner.revokeGroupMember(GROUP, agentAccount);
    console.log('✓ agent revoked (group key rotated)');
  } else console.log('· agent is not a member');
  console.log(`  is_authorized(agent) = ${await owner.isAuthorized(GROUP, agentAccount)}`);
  console.log('now the agent tries again — this MUST fail:');
  await read({ expectFailure: true });
}

async function readd() {
  const owner = ownerSdk();
  if (!(await owner.isAuthorized(GROUP, agentAccount))) await owner.addGroupMember(GROUP, agentAccount);
  console.log(`✓ is_authorized(agent) = ${await owner.isAuthorized(GROUP, agentAccount)}`);
}

async function list() {
  const state = readJson(STATE);
  try {
    const rows = await agentSdk().getTransactionsForGroup(GROUP);
    const mine = rows.find((r) => r.ipfs_hash === state.upload?.location);
    console.log(`✓ agent listed ${rows.length} file(s); the uploaded proof is ${mine ? 'present' : 'MISSING'}` +
      (mine ? ` (file_hash ${mine.file_hash === state.upload.file_hash ? 'matches' : 'DIFFERS'})` : ''));
  } catch (e) {
    console.log(`✗ agent listing refused: ${short(e)}`);
  }
}

async function agentUpload() {
  try {
    await agentSdk().upload(GROUP, Buffer.from('should never be stored'), 'agent-attempt.txt');
    console.log('✗ agent upload was ACCEPTED (expected a refusal)');
  } catch (e) {
    console.log(`${/not supported/i.test(String(e?.message ?? e)) ? '✓' : '?'} agent upload refused: ${short(e)}`);
  }
}

const cmd = process.argv[2];
const run = { setup, read: () => read(), revoke, readd, list, 'agent-upload': agentUpload }[cmd];
if (!run) die('usage: node aa_readpath.mjs setup | read | revoke | readd | list | agent-upload');
run().catch((e) => die(short(e)));
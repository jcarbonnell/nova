// shade-agent/test/test-near-key-lookup.mjs
//
// HARNESS-FIRST (§10) for src/lib/near-key-lookup.ts — the typed lookup that
// decides whether the implicit-account branch may open. The security property:
// ONLY a definitive UNKNOWN_ACCOUNT reply yields { no_account }; every other
// non-answer THROWS (→ KEY_LOOKUP_UNAVAILABLE, nothing consumed).
//
//   OFFLINE (always): a fake POST replays each RPC reply shape, including the
//     ones that must NOT be trusted (legacy result.error, unknown causes, HTTP
//     error bodies, transport failure, garbage).
//   ONLINE (ONLINE=1, read-only mainnet views, no keys): confirms the provider
//     really emits the shapes the offline layer assumes, then runs the REAL
//     verifier end-to-end with the REAL lookup for a fresh implicit key.
//
// RUN (from shade-agent/):
//   node --experimental-strip-types test/test-near-key-lookup.mjs
//   ONLINE=1 node --experimental-strip-types test/test-near-key-lookup.mjs
//   (ONLINE uses NEAR_RPC_URL if set, else the config default.)

import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { Near, InMemoryKeyStore, generateKey } from 'near-kit';
import { makeKeyLookup } from '../src/lib/near-key-lookup.ts';
import { AgentChallengeStore, verifyAgentIdentity } from '../src/lib/agent-identity.ts';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}`); }
}
async function rejects(p) { try { await p; return false; } catch { return true; } }

const ACC = 'alice.near';
const PK = 'ed25519:11111111111111111111111111111111'; // 32 zero bytes
const OTHER = generateKey().publicKey.toString();

// Fake POST: script = { <request_type>: reply | fn(nthCall) }.
function fakePost(script) {
  const calls = [];
  const post = async (_url, body) => {
    const t = body.params.request_type;
    calls.push(t);
    const r = script[t];
    if (typeof r === 'function') return r(calls.filter((c) => c === t).length);
    return r;
  };
  post.calls = calls;
  return post;
}
const ACCOUNT_OK = { result: { amount: '1000', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 100, block_height: 1, block_hash: 'x' } };
const err = (name) => ({ error: { name: 'HANDLER_ERROR', cause: { name, info: {} }, code: -32000, message: 'Server error' } });
const FC = { FunctionCall: { allowance: null, receiver_id: 'x.near', method_names: [] } };
const keyList = (...entries) => ({ result: { keys: entries.map(([pk, permission]) => ({ public_key: pk, access_key: { nonce: 1, permission } })), block_height: 1, block_hash: 'x' } });
const lookupWith = (script) => makeKeyLookup({ rpcUrl: 'http://fake', post: fakePost(script) });
const withKeys = (list) => lookupWith({ view_account: ACCOUNT_OK, view_access_key_list: list });

async function main() {
  console.log('\nNEAR key lookup harness\n');

  console.log('OFFLINE — definitive answers:');
  check('1.1 UNKNOWN_ACCOUNT → no_account',
    (await lookupWith({ view_account: err('UNKNOWN_ACCOUNT') })(ACC, PK)).kind === 'no_account');
  {
    const post = fakePost({ view_account: err('UNKNOWN_ACCOUNT'), view_access_key_list: () => { throw new Error('must not be called'); } });
    await makeKeyLookup({ rpcUrl: 'x', post })(ACC, PK);
    check('1.2 no_account short-circuits (key list never fetched)', post.calls.join() === 'view_account');
  }
  check('1.3 account exists, key not in its list → no_access_key',
    (await withKeys(keyList([OTHER, 'FullAccess']))(ACC, PK)).kind === 'no_access_key');
  check('1.4 account exists with an EMPTY key list → no_access_key',
    (await withKeys(keyList())(ACC, PK)).kind === 'no_access_key');
  {
    const r = await withKeys(keyList([OTHER, FC], [PK, 'FullAccess']))(ACC, PK);
    check('1.5 key listed FullAccess (among others) → access_key/FullAccess', r.kind === 'access_key' && r.permission === 'FullAccess');
  }
  {
    const r = await withKeys(keyList([PK, FC]))(ACC, PK);
    check('1.6 key listed { FunctionCall } → access_key/FunctionCall', r.kind === 'access_key' && r.permission === 'FunctionCall');
  }
  {
    // Match is by decoded bytes, not string: an unparseable entry is skipped, not fatal.
    const r = await withKeys(keyList(['secp256k1:zzz', 'FullAccess'], [PK, 'FullAccess']))(ACC, PK);
    check('1.7 an unparseable list entry is skipped; the real match still found', r.kind === 'access_key');
  }

  console.log('\nOFFLINE — non-answers must THROW (never no_account / no_access_key):');
  check('2.1 view_account cause UNKNOWN_BLOCK → throws', await rejects(lookupWith({ view_account: err('UNKNOWN_BLOCK') })(ACC, PK)));
  check('2.2 view_account cause TIMEOUT_ERROR → throws', await rejects(lookupWith({ view_account: err('TIMEOUT_ERROR') })(ACC, PK)));
  check('2.3 view_account error with no cause → throws', await rejects(lookupWith({ view_account: { error: { message: 'Account does not exist' } } })(ACC, PK)));
  check('2.4 HTTP-error HTML/empty body (non-object) → throws', await rejects(lookupWith({ view_account: '<html>502</html>' })(ACC, PK)));
  check('2.5 view_account result without amount → throws', await rejects(lookupWith({ view_account: { result: {} } })(ACC, PK)));
  check('2.6 key list carrying a legacy result.error → throws (text not parsed)',
    await rejects(withKeys({ result: { error: 'something does not exist while viewing', logs: [] } })(ACC, PK)));
  check('2.7 key list cause UNKNOWN_ACCOUNT (race: deleted between calls) → throws',
    await rejects(withKeys(err('UNKNOWN_ACCOUNT'))(ACC, PK)));
  check('2.8 our key listed with an unknown permission shape (e.g. gas keys) → throws',
    await rejects(withKeys(keyList([PK, { GasKeyFullAccess: {} }]))(ACC, PK)));
  check('2.9 key list without `keys` array → throws', await rejects(withKeys({ result: {} })(ACC, PK)));
  check('2.10 list entry with no public_key → throws (malformed list ≠ "not present")',
    await rejects(withKeys({ result: { keys: [{ access_key: { permission: 'FullAccess' } }] } })(ACC, PK)));
  {
    const post = fakePost({ view_account: () => { throw new Error('ECONNRESET'); } });
    const threw = await rejects(makeKeyLookup({ rpcUrl: 'x', post })(ACC, PK));
    check('2.11 transport failure → throws after exactly one retry', threw && post.calls.length === 2);
  }
  {
    const post = fakePost({ view_account: (n) => { if (n === 1) throw new Error('ETIMEDOUT'); return err('UNKNOWN_ACCOUNT'); } });
    const r = await makeKeyLookup({ rpcUrl: 'x', post })(ACC, PK);
    check('2.12 transient transport failure then a definitive answer → answer used', r.kind === 'no_account');
  }
  {
    const post = fakePost({ view_account: err('UNKNOWN_BLOCK') });
    await rejects(makeKeyLookup({ rpcUrl: 'x', post })(ACC, PK));
    check('2.13 an RPC error body is NOT retried (only transport is)', post.calls.length === 1);
  }

  if (process.env.ONLINE !== '1') {
    console.log('\nONLINE: skipped (set ONLINE=1 to probe mainnet, read-only).');
  } else {
    const rpcUrl = process.env.NEAR_RPC_URL || 'https://rpc.mainnet.fastnear.com';
    console.log(`\nONLINE — mainnet, read-only (${rpcUrl.replace(/\?.*$/, '?…')}):`);
    const post = async (url, body) => (await axios.post(url, body, { timeout: 10_000, validateStatus: () => true })).data;
    const lookup = makeKeyLookup({ rpcUrl, post });

    const fresh = randomBytes(32).toString('hex');
    check('3.1 random 64-hex account → no_account (provider emits UNKNOWN_ACCOUNT)', (await lookup(fresh, PK)).kind === 'no_account');
    check('3.2 nova-sdk.near + random key → no_access_key (absent from the real key list)',
      (await lookup('nova-sdk.near', 'ed25519:' + 'A'.repeat(43))).kind === 'no_access_key');

    const list = await post(rpcUrl, { jsonrpc: '2.0', id: 'l', method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: 'nova-sdk.near' } });
    const fa = list?.result?.keys?.find((k) => k.access_key?.permission === 'FullAccess');
    const fc = list?.result?.keys?.find((k) => typeof k.access_key?.permission === 'object');
    if (fa) {
      const r = await lookup('nova-sdk.near', fa.public_key);
      check('3.3 a real full-access key on nova-sdk.near → access_key/FullAccess', r.kind === 'access_key' && r.permission === 'FullAccess');
    } else console.log('  (3.3 skipped: no full-access key listed)');
    if (fc) {
      const r = await lookup('nova-sdk.near', fc.public_key);
      check('3.4 a real function-call key on nova-sdk.near → access_key/FunctionCall', r.kind === 'access_key' && r.permission === 'FunctionCall');
    } else console.log('  (3.4 skipped: no function-call key listed)');

    // End-to-end: real verifier + real lookup, fresh implicit key (not on chain).
    const kp = generateKey();
    const id = Buffer.from(kp.publicKey.data).toString('hex');
    const near = new Near({ network: 'mainnet', keyStore: new InMemoryKeyStore({ [id]: kp.secretKey }), defaultSignerId: id });
    const store = new AgentChallengeStore({ audience: 'nova-sdk.near' });
    const { challenge, message } = store.issue();
    const nonce = randomBytes(32);
    const sm = await near.signMessage({ message, recipient: 'nova-sdk.near', nonce }, { signerId: id });
    const r = await verifyAgentIdentity({ store, lookup }, {
      challenge: challenge.challenge,
      signature: { near_account_id: id, public_key: sm.publicKey, signature: Buffer.from(sm.signature, 'base64').toString('hex'), nonce: nonce.toString('base64'), recipient: 'nova-sdk.near' },
    });
    check('3.5 END-TO-END: fresh implicit key signs a NOVA challenge → verified via real mainnet lookup', r.ok === true && r.account_id === id);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  FAILURES:\n${failures.map((f) => `    - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('  ✅ all green');
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });

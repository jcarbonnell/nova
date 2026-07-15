// test-prod-parity.mjs — production parity check for v0.4 step 6.2.
//
// Verifies that the legacy Hono surface (/api/*) and the new oRPC surface (/rpc/*)
// return IDENTICAL responses for request paths that the in-process harness
// structurally cannot cover — the ones that hit KV, NEAR RPC, and real
// production data.
//
// This is the check that licenses flipping MCP and the frontend to /rpc (step 6.4).
//
// DESIGN NOTES (learned the hard way):
//   - The secret is read from shade-agent/.env. It never appears in a terminal,
//     in shell history, or in a chat.
//   - Each case ASSERTS ITS EXPECTED OUTCOME FIRST, then compares the two
//     surfaces. A naive diff would pass if BOTH surfaces failed identically —
//     two 403s diff clean and prove nothing.
//   - Key material is never printed. Only lengths, prefixes and key names.
//
// Run from shade-agent/:
//     node test-prod-parity.mjs

import { readFileSync } from 'fs';
import path from 'path';

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────

const HOST = process.env.SHADE_HOST
  || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-3000.dstack-prod5.phala.network';

const TEST_ACCOUNT = process.env.PARITY_ACCOUNT || 'gmail-14.nova-sdk.near';

// ────────────────────────────────────────────────
// Load the secret from .env — never from the CLI
// ────────────────────────────────────────────────

function loadSecret() {
  const envPath = path.resolve(process.cwd(), '.env');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    console.error(`FATAL: cannot read ${envPath}`);
    console.error('Run this from shade-agent/, where .env lives.');
    process.exit(2);
  }

  const line = raw.split('\n').find((l) => l.trim().startsWith('INTERNAL_API_SECRET='));
  if (!line) {
    console.error('FATAL: INTERNAL_API_SECRET not found in .env');
    process.exit(2);
  }

  const secret = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');

  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    console.error(`FATAL: INTERNAL_API_SECRET is not 64-char hex (got ${secret.length} chars).`);
    console.error('checkInternalAuth fails closed on a malformed secret — every request would 403.');
    process.exit(2);
  }

  console.log(`🔑 Secret loaded from .env (64-char hex, ok)\n`);
  return secret;
}

const SECRET = loadSecret();

// ────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────

async function call(pathname, body) {
  const res = await fetch(`${HOST}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Auth': SECRET,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __raw: text }; }
  return { status: res.status, body: json };
}

// ────────────────────────────────────────────────
// Reporting — never prints secrets or key material
// ────────────────────────────────────────────────

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `\n         ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

/** Describe a response without leaking anything sensitive. */
const redact = (r) => {
  const keys = Object.keys(r.body).sort().join(',');
  const pk = typeof r.body.private_key === 'string'
    ? `private_key=<${r.body.private_key.length} chars, "${r.body.private_key.slice(0, 8)}…">`
    : '';
  return `status=${r.status} keys=[${keys}] ${pk}`.trim();
};

const deepEqual = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

/**
 * Run one case against BOTH surfaces.
 *
 * `assertOutcome` must return true for the EXPECTED result. If it returns false,
 * the case fails EVEN IF both surfaces agree — because two identical failures
 * are not parity, they are just two failures. This is the bug that made a naive
 * `diff` report IDENTICAL on two 403s.
 */
async function parity(name, legacyPath, rpcPath, payload, assertOutcome, expectation) {
  console.log(`\n▸ ${name}`);

  const legacy = await call(legacyPath, payload);
  const rpc = await call(rpcPath, payload);

  console.log(`    legacy: ${redact(legacy)}`);
  console.log(`    rpc   : ${redact(rpc)}`);

  const legacyOk = assertOutcome(legacy);
  const rpcOk = assertOutcome(rpc);

  check(`legacy produced the expected outcome (${expectation})`, legacyOk);
  check(`rpc produced the expected outcome (${expectation})`, rpcOk);

  if (legacyOk && rpcOk) {
    check('both surfaces returned an IDENTICAL body', deepEqual(legacy.body, rpc.body));
    check('both surfaces returned the SAME status', legacy.status === rpc.status,
      `legacy=${legacy.status} rpc=${rpc.status}`);
  } else {
    check('parity comparison skipped — an outcome assertion failed first', false,
      'Fix the outcome before trusting the comparison.');
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('═'.repeat(74));
console.log(`PRODUCTION PARITY  —  ${HOST}`);
console.log('═'.repeat(74));

// ── Case 1: THE ONE THAT MATTERS ────────────────────────────────────────────
// Account-only retrieve. This is MCP's signing path — the exact call it makes on
// every group operation, and the first thing that flips to /rpc in step 6.4.
// It reads a REAL production KV blob (still legacy CBC), decrypts it, and returns
// a real private key. No in-process harness can cover this.
await parity(
  'user-keys/retrieve (account-only) — MCP\'s signing path',
  '/api/user-keys/retrieve',
  '/rpc/user-keys/retrieve',
  { account_id: TEST_ACCOUNT },
  (r) =>
    r.status === 200 &&
    typeof r.body.private_key === 'string' &&
    r.body.private_key.startsWith('ed25519:') &&
    r.body.account_id === TEST_ACCOUNT,
  '200 + a real ed25519 private key for the test account',
);

// ── Case 2: NEAR RPC view path, authorisation denied ────────────────────────
// Exercises resolveContract + viewFunction('is_authorized') against the live
// contract. The test account owns no groups, so 403 UNAUTHORIZED is CORRECT —
// and proving both surfaces reach the same on-chain answer is the point.
await parity(
  'key-management/get_key — live is_authorized view (expect denial)',
  '/api/key-management/get_key',
  '/rpc/key-management/get_key',
  { group_id: '__parity_probe__', account_id: TEST_ACCOUNT, contract_id: 'nova-sdk.near' },
  (r) => r.status === 403 && r.body.code === 'UNAUTHORIZED',
  '403 UNAUTHORIZED from the live contract',
);

// ── Case 3: NEAR RPC view path, group missing ───────────────────────────────
// Exercises viewFunction('group_contains_key'). Read-only: no key is derived and
// nothing is written, because the 404 fires first.
await parity(
  'key-management/generate_key — live group_contains_key view (expect not-found)',
  '/api/key-management/generate_key',
  '/rpc/key-management/generate_key',
  { group_id: '__parity_probe_missing__', contract_id: 'nova-sdk.near' },
  (r) => r.status === 404 && r.body.code === 'GROUP_NOT_FOUND',
  '404 GROUP_NOT_FOUND from the live contract',
);

// ── Case 4: the gate still fails closed on BOTH surfaces ────────────────────
console.log('\n▸ gate fails closed (no X-Internal-Auth) on both surfaces');
{
  const bare = async (p) => {
    const res = await fetch(`${HOST}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_id: TEST_ACCOUNT }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const l = await bare('/api/user-keys/retrieve');
  const r = await bare('/rpc/user-keys/retrieve');
  console.log(`    legacy: status=${l.status} ${JSON.stringify(l.body)}`);
  console.log(`    rpc   : status=${r.status} ${JSON.stringify(r.body)}`);
  check('legacy rejects with 403', l.status === 403);
  check('rpc rejects with 403', r.status === 403);
  check('neither leaks a private key', !l.body.private_key && !r.body.private_key);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(74));
if (fail === 0) {
  console.log(`ALL ${pass} CHECKS PASSED`);
  console.log('Both surfaces are behaviourally identical on real production data.');
  console.log('→ Safe to flip MCP and the frontend to /rpc (step 6.4).');
  process.exit(0);
} else {
  console.log(`${fail}/${pass + fail} FAILED — DO NOT FLIP CONSUMERS TO /rpc.`);
  process.exit(1);
}
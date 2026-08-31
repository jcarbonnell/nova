// test-a1-view-methods-smoke.mjs
// A1 smoke test — the three NEW nova-sdk-js view methods against the LIVE prod MCP.
// Proves getOwnedGroups / getMemberGroups / getGroupMembers route SDK → MCP → contract
// and return real data for an authenticated caller. READ-ONLY: no upload, no on-chain
// write, no cleanup burden.
//
// Verifies, in the §10 order:
//   1. security invariant — a junk API key CANNOT read groups (throws, never returns data)
//   2. happy path        — a real API key lists owned groups, member groups, and the
//                          members of a group the caller owns
//
// Run from YOUR machine (network reaches the CVM), MCP logs open so a missing route /
// gate failure shows as a Shade 404/403 in the request log:
//   NOVA_API_KEY=<gmail-14 key> node test-a1-view-methods-smoke.mjs

import assert from 'node:assert/strict';

// Same import shape as test-f3-sdk-smoke.mjs — adjust only if that one differed.
import pkg from './dist/index.js';
const { NovaSdk, NovaError } = pkg;

const MCP_URL = process.env.MCP_URL
  || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const API_KEY = process.env.NOVA_API_KEY;
const ACCOUNT = process.env.SMOKE_ACCOUNT || 'gmail-14.nova-sdk.near';

if (!API_KEY) {
  console.error('Set NOVA_API_KEY (gmail-14.nova-sdk.near API key).');
  process.exit(1);
}

console.log(`\nA1 view-methods smoke — MCP=${MCP_URL}\n  account=${ACCOUNT}\n`);

// ── 1. SECURITY INVARIANT ─────────────────────────────────────────────────────
// A junk API key must NOT yield group data. The SDK exchanges the key for a session
// token on first call; a bad key fails at that stage, so getOwnedGroups throws.
{
  const bad = new NovaSdk(ACCOUNT, { mcpUrl: MCP_URL, apiKey: 'nova_sk_junk_key_that_should_never_authenticate' });
  let threw = false;
  try {
    await bad.getOwnedGroups();
  } catch (e) {
    threw = true;
    assert.ok(e instanceof NovaError, `expected NovaError, got ${e?.constructor?.name}: ${e}`);
  }
  assert.ok(threw, 'SECURITY FAIL: getOwnedGroups() returned data with a junk API key');
  console.log('  ✓ security invariant — junk key rejected, no group data returned');
}

// ── 2. HAPPY PATH ─────────────────────────────────────────────────────────────
const client = new NovaSdk(ACCOUNT, { mcpUrl: MCP_URL, apiKey: API_KEY });

const owned = await client.getOwnedGroups();
assert.ok(Array.isArray(owned), `getOwnedGroups did not return an array: ${JSON.stringify(owned)}`);
console.log(`  ✓ getOwnedGroups → ${owned.length} group(s)${owned.length ? ': ' + owned.slice(0, 5).join(', ') + (owned.length > 5 ? ' …' : '') : ''}`);

const member = await client.getMemberGroups();
assert.ok(Array.isArray(member), `getMemberGroups did not return an array: ${JSON.stringify(member)}`);
console.log(`  ✓ getMemberGroups → ${member.length} group(s)${member.length ? ': ' + member.slice(0, 5).join(', ') + (member.length > 5 ? ' …' : '') : ''}`);

// getGroupMembers needs a group the caller is authorized on. Prefer an owned group;
// fall back to a member group; skip only if the account has neither (fresh account).
const probeGroup = owned[0] ?? member[0];
if (probeGroup) {
  const members = await client.getGroupMembers(probeGroup);
  assert.ok(Array.isArray(members), `getGroupMembers did not return an array: ${JSON.stringify(members)}`);
  console.log(`  ✓ getGroupMembers('${probeGroup}') → ${members.length} member(s)${members.length ? ': ' + members.slice(0, 5).join(', ') + (members.length > 5 ? ' …' : '') : ''}`);
} else {
  console.log('  ⚠ getGroupMembers — SKIPPED (account owns/joins no group to probe); create one and re-run to cover it');
}

console.log('\nA1 SMOKE PASS — three view methods route SDK → MCP → contract, gated + returning data.\n');
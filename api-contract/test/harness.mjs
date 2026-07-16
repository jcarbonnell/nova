#!/usr/bin/env node
// nova/api-contract/test/harness.mjs
//
// USAGE:
//   npm run build
//   NOVA_SESSION_TOKEN=eyJ... npm run harness            # read-only
//   NOVA_SESSION_TOKEN=eyJ... npm run harness -- --write # + mutating sweep (spends NEAR)

import crypto from 'node:crypto';
import { contract } from '../dist/contract.js';
import { createNovaClient } from '../dist/client.js';

const MCP_URL =
  process.env.NOVA_MCP_URL ||
  'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const TOKEN = process.env.NOVA_SESSION_TOKEN;
const WRITE = process.argv.includes('--write');

if (!TOKEN) {
  console.error('✗ NOVA_SESSION_TOKEN required (export it; do not paste it inline).');
  process.exit(2);
}

const WRITE_GROUP = 'orpc-test';

// Read wire path + output schema off the compiled contract for an op.
function info(op) {
  const proc = contract[op]['~orpc'];
  return { path: proc.route.path, outputSchema: proc.outputSchema };
}

// Raw POST. Returns { status, body }.
async function call(op, body) {
  const { path } = info(op);
  const res = await fetch(`${MCP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* asserted by caller */
  }
  return { status: res.status, body: parsed };
}

// Assert-before-compare, then schema-validate. Returns a result record.
function verify(op, status, body) {
  if (status !== 200) {
    return { op, ok: false, detail: `expected HTTP 200, got ${status} — ${JSON.stringify(body)}` };
  }
  if (!body || typeof body !== 'object' || !('result' in body)) {
    return { op, ok: false, detail: `missing { result } envelope — ${JSON.stringify(body)}` };
  }
  const parsed = info(op).outputSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { op, ok: false, detail: `contract mismatch — ${issues} — ${JSON.stringify(body)}` };
  }
  return { op, ok: true, detail: JSON.stringify(body.result) };
}

// A declarative case: one call, one verify.
async function runCase({ op, body }) {
  const { status, body: resBody } = await call(op, body);
  return verify(op, status, resBody);
}

// ── read-only cases (safe on every run) ──────────────────────────────────────
const CASES = [
  { op: 'getOwnedGroups', body: {} },
  { op: 'authStatus', body: { group_id: 'mcp-test-group' } },
  { op: 'getMemberGroups', body: {} },
];

async function main() {
  console.log(`\nNOVA contract honesty harness → ${MCP_URL}`);
  console.log(`Token: ${TOKEN.slice(0, 10)}…  Mode: ${WRITE ? 'read + WRITE sweep' : 'read-only'}\n`);

  const results = [];

  console.log('Read-only:');
  for (const c of CASES) {
    const r = await runCase(c);
    results.push(r);
    console.log(r.ok ? `  ✓ ${r.op}  → ${r.detail}` : `  ✗ ${r.op}  → ${r.detail}`);
  }

  // ── Client transport proof ─── 
  // proves the published OpenAPILink CLIENT actually speaks FastMCP's dialect.
  console.log('\nClient transport (OpenAPILink → MCP):');
  {
    const client = createNovaClient({ token: TOKEN, mcpUrl: MCP_URL });
    try {
      const out = await client.getOwnedGroups({});
      // The client returns the full { result } body per the contract's output
      // schema. Validate it the same way, so a dialect mismatch is caught.
      const r = verify('getOwnedGroups', 200, out);
      results.push({ ...r, op: 'getOwnedGroups [client]' });
      console.log(
        r.ok
          ? `  ✓ getOwnedGroups [client]  → ${r.detail}`
          : `  ✗ getOwnedGroups [client]  → ${r.detail}`,
      );
    } catch (e) {
      results.push({
        op: 'getOwnedGroups [client]',
        ok: false,
        detail: `OpenAPILink threw: ${e?.message || e} — contract is honest (raw passed); transport diverges`,
      });
      console.log(`  ✗ getOwnedGroups [client]  → OpenAPILink threw: ${e?.message || e}`);
    }
  }

  if (WRITE) {
    console.log(`\nWRITE sweep (fixture group "${WRITE_GROUP}", spends NEAR):`);

    // 1. register_group — creates the group, makes caller owner+authorized.
    {
      const { status, body } = await call('registerGroup', { group_id: WRITE_GROUP });
      const r = verify('registerGroup', status, body);
      results.push(r);
      console.log(r.ok ? `  ✓ registerGroup  → ${r.detail}` : `  ✗ registerGroup  → ${r.detail}`);
      if (!r.ok) {
        console.log('  · aborting sweep — no authorized group to exercise.');
        return finish(results);
      }
    }

    // 2. authorized-only reads now succeed against the owned group.
    for (const op of ['getGroupMembers', 'getGroupTransactions']) {
      const { status, body } = await call(op, { group_id: WRITE_GROUP });
      const r = verify(op, status, body);
      results.push(r);
      console.log(r.ok ? `  ✓ ${op}  → ${r.detail}` : `  ✗ ${op}  → ${r.detail}`);
    }

    // 3. add_group_member (nova-sdk.near is a safe, real account to add).
    {
      const { status, body } = await call('addGroupMember', { group_id: WRITE_GROUP, member_id: 'nova-sdk.near' });
      const r = verify('addGroupMember', status, body);
      results.push(r);
      console.log(r.ok ? `  ✓ addGroupMember  → ${r.detail}` : `  ✗ addGroupMember  → ${r.detail}`);
    }

    // 4. finalize_upload round trip: prepare_upload → encrypt → finalize → prepare_retrieve.
    {
      const prep = await call('prepareUpload', { group_id: WRITE_GROUP, filename: 'harness-roundtrip.enc' });
      const pr = verify('prepareUpload', prep.status, prep.body);
      results.push(pr);
      console.log(pr.ok ? `  ✓ prepareUpload  → ${pr.detail}` : `  ✗ prepareUpload  → ${pr.detail}`);

      if (pr.ok) {
        const { upload_id, key } = prep.body.result;
        const plaintext = Buffer.from('orpc harness round trip');
        const keyBytes = Buffer.from(key, 'base64');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
        const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const encrypted_data = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
        const file_hash = crypto.createHash('sha256').update(plaintext).digest('hex');

        const fin = await call('finalizeUpload', { upload_id, encrypted_data, file_hash });
        const fr = verify('finalizeUpload', fin.status, fin.body);
        results.push(fr);
        console.log(fr.ok ? `  ✓ finalizeUpload  → ${fr.detail}` : `  ✗ finalizeUpload  → ${fr.detail}`);

        if (fr.ok) {
          const cid = fin.body.result.cid;
          const ret = await call('prepareRetrieve', { group_id: WRITE_GROUP, ipfs_hash: cid });
          const rr = verify('prepareRetrieve', ret.status, ret.body);
          results.push(rr);
          console.log(rr.ok ? `  ✓ prepareRetrieve  → ${rr.detail}` : `  ✗ prepareRetrieve  → ${rr.detail}`);
        }
      }
    }

    // 5. revoke_group_member — clean up the member, rotates the key.
    {
      const { status, body } = await call('revokeGroupMember', { group_id: WRITE_GROUP, member_id: 'nova-sdk.near' });
      const r = verify('revokeGroupMember', status, body);
      results.push(r);
      console.log(r.ok ? `  ✓ revokeGroupMember  → ${r.detail}` : `  ✗ revokeGroupMember  → ${r.detail}`);
    }

    console.log(`  · left group "${WRITE_GROUP}" on-chain (re-runs need a fresh group name or a funded re-register).`);
  }

  finish(results);
}

function finish(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} ops honest.`);
  if (failed.length) {
    console.log('Each failure means the contract lies about that op — fix the schema to match live MCP.');
    process.exit(1);
  }
  console.log('Contract is an honest description of live MCP. ✓');
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(1);
});
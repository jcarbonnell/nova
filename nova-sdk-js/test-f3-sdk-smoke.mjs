// test-f3-sdk-smoke.mjs
// F3 smoke test — the wired nova-sdk-js against the LIVE prod MCP, end to end.
// Proves SDK → MCP → Shade → FastFS is real: upload a throwaway blob, retrieve it,
// assert byte-identical, and assert the returned ref is a FastFS LOCATION (not a
// CID) — i.e. it went through the new v1 path, not a legacy fallback.
//
// Run from YOUR machine (network reaches the CVM), with MCP logs open so a
// missing route / gate failure shows as a Shade 404/403 in the request log:
//   NOVA_API_KEY=<gmail-14 key> node test-f3-sdk-smoke.mjs
//
// Touches only a throwaway random blob in the test group — no real data. (It does
// leave one record_transaction + FastFS envelope in engine-test-evt; harmless, and
// there's no SDK-exposed tombstone yet to clean it.)

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// ⚠️ CONFIRM THIS IMPORT against your build: class name + dist path/entry.
// (Common shapes: `import { NovaClient } from '../nova-sdk-js/dist/index.js'`
//  or a default export. Adjust to match your package's actual export.)
import pkg from './dist/index.js';
const { NovaSdk } = pkg;

const MCP_URL = process.env.MCP_URL
  || 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
const API_KEY = process.env.NOVA_API_KEY;
const GROUP = process.env.SMOKE_GROUP || 'engine-test-evt';

if (!API_KEY) {
  console.error('Set NOVA_API_KEY (gmail-14.nova-sdk.near API key).');
  process.exit(1);
}

// Constructor takes { mcpServerUrl, apiKey }; auth is internal (the API key is
// exchanged for a session token on the first callMcpTool — no separate step).
const client = new NovaSdk('gmail-14.nova-sdk.near', { mcpUrl: MCP_URL, apiKey: API_KEY });

console.log(`\nF3 SDK smoke — MCP=${MCP_URL}\n  group=${GROUP}\n`);

const data = Buffer.from(crypto.randomBytes(4096)); // throwaway payload

// ── upload ──
const up = await client.upload(GROUP, data);
console.log('  upload →', { ref: up.cid, trans_id: up.trans_id, file_hash: up.file_hash?.slice(0, 12) });

// It must be a FastFS LOCATION, not an IPFS CID — proves the new path fired.
const isFastFsLocation = up.cid.includes('/')
  && !up.cid.startsWith('Qm') && !up.cid.startsWith('bafy');
assert.ok(isFastFsLocation, `expected a FastFS location, got "${up.cid}" — did it fall back to IPFS?`);

// ── retrieve (by the location the upload returned) ──
const down = await client.retrieve(GROUP, up.cid);
assert.ok(Buffer.from(down.data).equals(data), 'retrieved bytes do not match uploaded plaintext');

console.log('\n  ✓ FastFS location returned (not a CID)');
console.log('  ✓ retrieve decoded byte-identical to upload');
console.log('\nSMOKE PASS — SDK → MCP → Shade → FastFS proven end to end.\n');

// shade-agent/test/mutate-legacy.mjs
//
// Mutation check for test/test-legacy.mjs. Each mutant edits ONE line of the
// compiled dist/ (exact text, which must occur once), runs the harness, and must
// turn every named check ✗. dist/ is restored after each mutant, also on failure.
//
// Build first:  npm run build
// Run:          node ./test/mutate-legacy.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const L = 'dist/lib/legacy.js', K = 'dist/lib/services/key-management.js';
const MUTANTS = [
  ['M1 the pre-switch KV read first (legacy shadows current)', L,
    'const current = await strictRead(keyId, KV_CONTRACT);',
    'const current = (await strictRead(keyId, LEGACY_KV_CONTRACT)) ? null : await strictRead(keyId, KV_CONTRACT);', ['E4']],
  ['M2 a KV read failure taken as "absent"', L,
    'return await getBlobFromKVStrict(keyId, contract);',
    'return await getBlobFromKVStrict(keyId, contract).catch(() => null);', ['E7', 'E8', 'W2']],
  ['M3 a new file key wrapped under the era\'s seed', K,
    'const groupKey = deriveKey(groupSalt(group_id, network, contractId, version), 32);',
    'const groupKey = await legacyDeriveKey(groupSalt(group_id, network, contractId, version), 32);', ['W1']],
  ['M4 getFileKey ignores the era (new seed always)', K,
    'const groupKey = await groupKeyFor(groupSalt(group_id, network, contractId, v), rec.era);',
    'const groupKey = deriveKey(groupSalt(group_id, network, contractId, v), 32);', ['E1', 'E2']],
  ['M5 getGroupKey ignores the era', K,
    'const keyBytes = await groupKeyFor(groupSalt(group_id, network, contractId, version), era);',
    'const keyBytes = deriveKey(groupSalt(group_id, network, contractId, version), 32);', ['G1']],
  ['M6 tombstones not checked', K,
    'if (decrypted.equals(TOMBSTONE))',
    'if (false)', ['E4', 'E5']],
  ['M7 no fingerprint pin', L,
    'if (fingerprint !== pins.secretFingerprint) {',
    'if (false) {', ['P2']],
  ['M8 no ciphertext pin', L,
    "if (crypto.createHash('sha256').update(raw).digest('hex') !== pins.masterRootSha256) {",
    'if (false) {', ['P3']],
  ['M9 no signer pin', L,
    'if (signer !== pins.signerPublicKey) {',
    'if (false) {', ['P4']],
  ['M10 no 32-byte check', L,
    'if (seed.length !== 32)',
    'if (false)', ['P5']],
  ['M11 no in-flight sharing', L,
    'if (!inFlight)',
    'if (true)', ['P7']],
  ['M12 no guard against KV_CONTRACT_ID = nova-kv.near', L,
    'if (KV_CONTRACT === LEGACY_KV_CONTRACT) {',
    'if (false) {', ['P8']],
  ['M13 getFileKey reads before authorizing', K,
    '    await authorizeForGroup(group_id, contractId, network, token, account_id);\n    // §5.12 L2: the current KV first',
    '    // §5.12 L2: the current KV first', ['E6']],
];

const run = () => (spawnSync(process.execPath, ['test/test-legacy.mjs'], { encoding: 'utf8', timeout: 120_000 }).stdout ?? '');
const baseline = run();
if (!/\n(\d+)\/\1 passed/.test(baseline)) { console.log('baseline not green: fix the harness first'); process.exit(1); }

let caught = 0;
for (const [name, file, from, to, expect] of MUTANTS) {
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { console.log(`  ✗ ${name}: target found ${n} times in ${file}`); continue; }
  try {
    writeFileSync(file, src.replace(from, to));
    const o = run();
    const red = expect.filter((id) => new RegExp(`✗ ${id} `).test(o));
    if (red.length === expect.length) { caught++; console.log(`  ✓ ${name} → ${expect.join(', ')} ✗`); }
    else console.log(`  ✗ ${name}: still green: ${expect.filter((id) => !red.includes(id)).join(', ')}`);
  } finally {
    writeFileSync(file, src);
  }
}
console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);

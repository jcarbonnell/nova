// shade-agent/test/mutate-rekey.mjs
//
// Mutation check for test/test-rekey.mjs. Each mutant edits ONE line of the
// compiled dist/ (exact text, which must occur once), runs the harness, and must
// turn every named check ✗. dist/ is restored after each mutant, also on failure.
//
// Build first:  npm run build
// Run:          node ./test/mutate-rekey.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const K = 'dist/lib/services/rekey.js';
const MUTANTS = [
  ['K1 no allowlist', K, 'if (!REKEY_ALLOWLIST.has(account_id)) {', 'if (false) {', ['R9']],
  ['K2 a sub naming another account accepted', K, 'if (old.account_id !== account_id)', 'if (false)', ['R10']],
  ['K3 wallet-linked records re-keyed', K, 'if (old.wallet_id)', 'if (false)', ['R10']],
  ['K4 any network', K, "if ((old.network ?? 'mainnet') !== 'mainnet')", 'if (false)', ['R10']],
  ['K5 a key that does not derive its public key used', K, '    if (!oldSeed)\n', '    if (false)\n', ['R10']],
  ['K6 the old key not checked on chain', K, '!keys.some((k) => k.public_key === oldPub && k.full)', 'false', ['R11']],
  ['K7 confirm ignored (plan changes things)', K, 'if (!confirm) {', 'if (false) {', ['R1']],
  ['K8 a new key drawn on every run', K, '    if (!pending) {', '    if (true) {', ['R7']],
  ['K9 the pending key not stored before sending', K,
    "        await storeBlobToKV(pendingIdFor(account_id), encryptBlob(Buffer.from(JSON.stringify(pending), 'utf8')));", '', ['R2', 'R7']],
  ['K10 other keys not deleted', K, '...deletes.map(encodeDeleteKey)', '...deletes.filter((pk) => pk === oldPub).map(encodeDeleteKey)', ['R4']],
  ['K11 no on-chain verification', K, 'if (!(after.length === 1 && after[0].public_key === newPub && after[0].full)) {', 'if (false) {', ['R12']],
  ['K12 user:{sub} not rewritten', K, '    await storeBlobToKV(userIdFor(sub), blob);\n', '', ['R5', 'R8']],
  ['K13 the pending record keeps its secret', K,
    'JSON.stringify({ done: true, new_public_key: newPub, old_public_key: oldPub })', 'JSON.stringify({ ...pending, done: true })', ['R5']],
  ['K14 done never detected', K, '        if (rec.rekeyed_at) {', '        if (false) {', ['R6']],
  ['K15 a current-era record taken as pre-switch', K, "if (!user || user.era !== 'legacy')", 'if (!user)', ['R15']],
];

const run = () => (spawnSync(process.execPath, ['test/test-rekey.mjs'], { encoding: 'utf8', timeout: 120_000 }).stdout ?? '');
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

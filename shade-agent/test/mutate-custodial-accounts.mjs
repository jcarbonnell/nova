// shade-agent/test/mutate-custodial-accounts.mjs
//
// Mutation check for test/test-custodial-accounts.mjs. Each mutant edits ONE spot
// of the compiled dist/ (exact text, which must occur once), runs the harness, and
// must turn every named check ✗. dist/ is restored after each mutant, also on failure.
//
// Build first:  npm run build
// Run:          node ./test/mutate-custodial-accounts.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const C = 'dist/lib/services/custodial-accounts.js', U = 'dist/lib/services/user-keys.js';
const MUTANTS = [
  ['A1 no allowlist', C, 'if (!CUSTODIAL_ALLOWLIST.has(accountId)) {', 'if (false) {', ['C1']],
  ['A2 extra keys accepted ("only key" not checked)', C, 'state.exists && state.keys.length === 1 && ', 'state.exists && ', ['C8']],
  ['A3 finalize without the chain check', C, '    if (!onlyKeyIs(state, pub)) {', '    if (false) {', ['C8']],
  ['A4 an absent account not named as such', C, '    if (!state.exists) {', '    if (false) {', ['C4']],
  ['A5 the record rewritten on every run', C, '    let created = false;\n    if (record) {', '    let created = false;\n    if (false) {', ['C6']],
  ['A6 a stored record with another key accepted', C,
    '    let created = false;\n    if (record) {\n        if (record.public_key !== pub) {', '    let created = false;\n    if (record) {\n        if (false) {', ['C9']],
  ['A7 the API key re-issued on every run', U, 'if (existing && !rotate)', 'if (false)', ['C6']],
  ['A8 reissue ignored', C, 'issueOperatorApiKey(account_id, !!reissue_api_key)', 'issueOperatorApiKey(account_id, false)', ['C7']],
  ['A9 an RPC failure read as "absent"', C, "if (err.cause?.name === 'UNKNOWN_ACCOUNT')", 'if (err)', ['C10']],
  ['A10 the API key logged', C, 'api_key_issued: !!issued,', 'api_key_issued: issued?.api_key,', ['C11']],
  ['A11 the record marked mainnet', C, 'network: NETWORK, wallet_id: null,', "network: 'mainnet', wallet_id: null,", ['C5', 'C13']],
  ['A13 the pre-switch owner account allowed again', C, "  'ironclaw-swarm-owner.nova-sdk-7.testnet',", "  'ironclaw-swarm.nova-sdk-7.testnet',", ['C1']],
  ['A12 another derivation salt', C, 'deriveKey(`custodial-account:${accountId}`, 32)', 'deriveKey(`custodial:${accountId}`, 32)', ['C2']],
];

const run = () => (spawnSync(process.execPath, ['test/test-custodial-accounts.mjs'], { encoding: 'utf8', timeout: 120_000 }).stdout ?? '');
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

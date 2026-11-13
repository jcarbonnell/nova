// shade-agent/test/mutate-hardening.mjs
//
// §5.12 hardening (no stale defaults): mutation check. Each mutant edits ONE line
// (exact text, found once), runs the named harness, and must turn every named
// check red (✗ or ❌). The file is restored after each mutant, also on failure.
// H6 edits src/ (B12 reads the sources); the others edit the compiled dist/.
//
// Build first:  npm run build
// Run:          node ./test/mutate-hardening.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const BC = 'dist/lib/boot-config.js';
const MUTANTS = [
  ['H1 AUTH0_AUDIENCE not required at boot', BC, "        ['AUTH0_AUDIENCE', auth0Audience],\n", '', 'test-boot-config', ['B2']],
  ['H2 nova-kv.near accepted as KV_CONTRACT_ID', BC, 'if (kvContractId === PRE_SWITCH_KV_CONTRACT) {', 'if (false) {', 'test-boot-config', ['B10']],
  ['H3 any AUTH0_AUDIENCE accepted', BC, 'if (!/^https:', 'if (false && !/^https:', 'test-boot-config', ['B11']],
  ['H4 the old audience default back in auth.ts', 'dist/lib/auth.js', 'const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;',
    "const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'https://old-cvm.invalid';", 'test-auth-regression', ['AUTH0_AUDIENCE unset']],
  ['H5 an unset KV_CONTRACT_ID accepted by the legacy reader', 'dist/lib/legacy.js',
    'if (!KV_CONTRACT || KV_CONTRACT === LEGACY_KV_CONTRACT) {', 'if (KV_CONTRACT === LEGACY_KV_CONTRACT) {', 'test-legacy', ['P8']],
  ['H6 the nova-kv.near default back in config.ts', 'src/lib/config.ts', "process.env.KV_CONTRACT_ID || '';",
    "process.env.KV_CONTRACT_ID || 'nova-kv.near';", 'test-boot-config', ['B12']],
];

const run = (t) => (spawnSync(process.execPath, [`test/${t}.mjs`], { encoding: 'utf8', timeout: 120_000 }).stdout ?? '');
for (const t of new Set(MUTANTS.map((m) => m[4]))) {
  if (/[✗❌]/.test(run(t))) { console.log(`baseline not green (${t}): fix it first`); process.exit(1); }
}

let caught = 0;
for (const [name, file, from, to, harness, expect] of MUTANTS) {
  const src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) { console.log(`  ✗ ${name}: target found ${n} times in ${file}`); continue; }
  try {
    writeFileSync(file, src.replace(from, to));
    const red = run(harness).split('\n').filter((l) => /[✗❌]/.test(l));
    const missed = expect.filter((id) => !red.some((l) => l.includes(id)));
    if (!missed.length) { caught++; console.log(`  ✓ ${name} → ${harness}: ${expect.join(', ')} red`); }
    else console.log(`  ✗ ${name}: still green: ${missed.join(', ')}`);
  } finally {
    writeFileSync(file, src);
  }
}
console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);

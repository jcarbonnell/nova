// shade-agent/test/mutate-registration.mjs
//
// Mutation check for test/test-registration.mjs. Each mutant edits ONE line of the
// compiled dist/ (exact text, which must occur once), runs the harness, and must
// turn every named check ✗. dist/ is restored after each mutant, also on failure.
//
// Build first:  npm run build
// Run:          node ./test/mutate-registration.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const G = 'dist/lib/registration.js', I = 'dist/index.js';
const MUTANTS = [
  ['M1 no backoff growth', G, 'wait = Math.min(wait * 2, RETRY_MAX_MS);', 'wait = Math.min(wait, RETRY_MAX_MS);', ['R3', 'R4', 'R12']],
  ['M2 no backoff cap', G, 'wait = Math.min(wait * 2, RETRY_MAX_MS);', 'wait = wait * 2;', ['R4']],
  ['M3 top-up only before the first attempt', G, '            await topUp();', '            if (state.attempts === 0) await topUp();', ['R3', 'R5']],
  ['M4 the old 0.05 NEAR minimum', G, 'AGENT_MIN_BALANCE_NEAR = 0.35', 'AGENT_MIN_BALANCE_NEAR = 0.05', ['R2']],
  ['M5 the old 0.1 NEAR top-up', G, 'AGENT_FUND_NEAR = 0.4', 'AGENT_FUND_NEAR = 0.1', ['R1', 'R2']],
  ['M6 a lagging view taken as the new validity', G, 'until > now() + REREGISTER_BEFORE_EXPIRY_MS', 'until > 0', ['R8']],
  ['M7 an unreadable validity guessed', G, '        return null;', '        return now() + 7 * 24 * 3600000;', ['R9']],
  ['M8 a fixed 6-day cycle', G, 'return Math.max(RETRY_FIRST_MS, state.validUntilMs - REREGISTER_BEFORE_EXPIRY_MS - now());', 'return REREGISTER_FALLBACK_MS;', ['R11']],
  ['M9 a re-registration gives up after one failure', G, '            await sleep(wait);', '            if (state.registeredAt) return;\n            await sleep(wait);', ['R12']],
  ['M10 validity ignores expiry', G, ' && state.validUntilMs > now();', ';', ['R10']],
  ['M11 not-whitelisted still registers', G, 'whitelisted === null || whitelisted', 'true', ['R7']],
  ['M12 a funding error is fatal', G, "log('warn', 'agent_funding_failed', { message: msg(e) });", 'throw e;', ['R5', 'R13']],
  ['M13 last_error not cleared on success', G, 'state.lastError = null;', '', ['R14']],
  ['M14 `/` healthy without validity', I, 'status: registrar?.isValid() && hasMasterSeed()', 'status: registrar?.state.phase === "registered" && hasMasterSeed()', ['I1']],
];

const run = () => (spawnSync(process.execPath, ['test/test-registration.mjs'], { encoding: 'utf8', timeout: 60_000 }).stdout ?? '');
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

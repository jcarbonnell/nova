// mutate-nova-agent-connect.mjs: each mutant breaks one guarantee; the harness must fail on every one.
//   node mutate-nova-agent-connect.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SRC = fs.readFileSync('nova-agent-connect.ts', 'utf8');
const MUTANTS = [
  ['persist AFTER send', [`      await store.save(p); // BEFORE sending\n`, ``], [`      const withId = { ...p, correlationId: first.correlation_id };`, `      await store.save(p);\n      const withId = { ...p, correlationId: first.correlation_id };`]],
  ['receiver check dropped', [`if (call.receiverId !== contract) throw`, `if (false) throw`]],
  ['method allowlist dropped', [`if (!(NOVA_WRITE_METHODS as readonly string[]).includes(call.methodName)) {`, `if (false) {`]],
  ['cap off by one (>=)', [`call.deposit > opts.maxDepositYocto`, `call.deposit >= opts.maxDepositYocto`]],
  ['retryable treated as refusal', [`&& !e.retryable) {`, `) {`]],
  ['replay under a new key', [`\n        st = await api.nativeNearCall(agentId, p.body, { idempotencyKey: p.idempotencyKey });`, `\n        st = await api.nativeNearCall(agentId, p.body, { idempotencyKey: 'nova-' + crypto.randomUUID() });`]],
  ['UNCERTAIN treated as settled', [`new Set(['PROCESSING', 'QUEUED', 'UNCERTAIN'])`, `new Set(['PROCESSING', 'QUEUED'])`]],
  ['pending check dropped', [`if (existing) {`, `if (false) {`]],
  ['NEEDS_REVIEW cleared', [`      if (final.status === 'NEEDS_REVIEW') {\n        throw`, `      if (final.status === 'NEEDS_REVIEW') {\n        await store.clear();\n        throw`]],
  ['FAILED keeps pending', [`      await store.clear(); // terminal\n`, `      if (final.status === 'SUCCESS') await store.clear();\n`]],
  ['agent-chosen nonce', [`recipient: ch.audience, nonce: ch.nonce }`, `recipient: ch.audience, nonce: 'X'.repeat(43) + '=' }`]],
  ['verify account check dropped', [`if (typeof v.token !== 'string' || v.account_id !== sig.near_account_id) {`, `if (typeof v.token !== 'string') {`]],
  ['connect account check dropped', [`if (session.accountId !== accountId) throw`, `if (false) throw`]],
  ['policy turns transfer on', [`next.native = native;`, `native.near.transfer = true;\n  next.native = native;`]],
  ['policy mutates input', [`const next: Policy = structuredClone(policy);`, `const next: Policy = policy;`]],
  ['instanceof only', [`  if (e instanceof AgentApiError) return true;\n  const x`, `  return e instanceof AgentApiError;\n  const x`]],
  ['no tx-hash check', [`if (!txHash) throw new Error(`, `if (false) throw new Error(`]],
];
let caught = 0;
for (const [name, ...edits] of MUTANTS) {
  let src = SRC;
  for (const [a, b] of edits) {
    if (src.split(a).length !== 2) { console.log(`✗ ${name}: anchor not found exactly once`); process.exit(2); }
    src = src.replace(a, b);
  }
  const file = `mutant-${name.replace(/\W+/g, '-')}.ts`;
  fs.writeFileSync(file, src);
  let failed = false;
  try { execFileSync('npx', ['tsx', 'test-nova-agent-connect.ts'], { env: { ...process.env, NAC_MODULE: file }, stdio: 'pipe' }); }
  catch (e) { failed = true; var out = String(e.stdout); }
  fs.rmSync(file);
  const which = failed ? (out.match(/^✗ .*$/m)?.[0] ?? 'harness crashed: ' + (out.trim().split('\n').pop() ?? '')) : '';
  console.log(`${failed ? '✓ caught' : '✗ SURVIVED'}  ${name}${failed ? `  (${which.slice(2, 60)})` : ''}`);
  if (failed) caught++;
}
console.log(`\n${caught}/${MUTANTS.length} mutants caught`);
process.exit(caught === MUTANTS.length ? 0 : 1);

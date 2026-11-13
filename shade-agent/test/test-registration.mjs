// shade-agent/test/test-registration.mjs
//
// §5.12 D1–D4 — lib/registration.ts with a fake agent, a fake clock and a sleep
// that only records (nothing waits). OFFLINE, no RPC.
//
//   R1 a first boot: tops up from 0 (0.4 NEAR) BEFORE register, then reads its
//      validity from get_agent; registered and valid
//   R2 D4: funds 0.4 NEAR below 0.35, nothing at 0.35 (constants 0.35 / 0.4)
//   R3 D3: failures back off 10 s, 20 s, 40 s, 80 s; a top-up precedes every attempt
//   R4 D3: the backoff is capped at 10 min
//   R5 D3: the 2026-11-12 failure ("not enough balance … costing 0.306"): a failed
//      top-up, then a top-up inside the loop, then registered
//   R6 no sponsor: never funds, still retries
//   R7 not whitelisted (false) → no register call, retried; null (TEE required) → registers
//   R8 D2: a lagging view (absent, then the previous expiry) is not taken; the fresh one is
//   R9 D2: validity never readable → null, never guessed; not valid; next cycle in 6 days
//   R10 D2: not valid once the contract's expiry has passed
//   R11 D1: the next cycle starts one day before the contract's expiry
//   R12 D1: a re-registration that fails retries with backoff until it succeeds
//   R13 a funding error is not fatal: register is still attempted
//   R14 success clears last_error; failed attempts are counted per cycle
//   I1 index.ts: `/` is healthy only through isValid(), reports valid_until_ms, and the
//      fixed setInterval / "Waiting for whitelist" loop is gone
//
// Mutations: test/mutate-registration.mjs.
// Build first:  npm run build
// Run:          node ./test/test-registration.mjs

import { readFileSync } from 'node:fs';
const R = await import('../dist/lib/registration.js');

const DAY = 24 * 3600_000, T0 = 1_794_000_000_000;

/** A scriptable fake ShadeClient. `script.register` is a list of outcomes per call. */
function world({ balance = 0, register = [true], whitelisted = null, views = null, fundFails = 0, hasSponsor = true } = {}) {
  const w = { t: T0, balance, calls: [], sleeps: [], regIdx: 0, viewIdx: 0, fundFails };
  w.agent = {
    accountId: () => 'agent.near',
    balance: async () => { w.calls.push('balance'); return w.balance; },
    fund: async (n) => {
      w.calls.push(`fund:${n}`);
      if (w.fundFails > 0) { w.fundFails--; throw new Error('sponsor transfer failed'); }
      w.balance += n;
    },
    isWhitelisted: async () => { w.calls.push('isWhitelisted'); return typeof whitelisted === 'function' ? whitelisted(w) : whitelisted; },
    register: async () => {
      w.calls.push('register');
      const o = register[Math.min(w.regIdx++, register.length - 1)];
      if (typeof o === 'function') return o(w);
      if (o instanceof Error) throw o;
      return o;
    },
    view: async ({ methodName }) => {
      w.calls.push(`view:${methodName}`);
      const v = views ? views[Math.min(w.viewIdx++, views.length - 1)] : { validity: 'Valid', valid_until_ms: String(w.t + 7 * DAY) };
      if (typeof v === 'function') return v(w);
      if (v instanceof Error) throw v;
      return v;
    },
  };
  w.reg = R.createRegistrar({
    agent: w.agent, hasSponsor,
    now: () => w.t,
    // A runaway retry loop (a mutant) fails the check instead of hanging the harness.
    sleep: async (ms) => { if (w.sleeps.length > 200) throw new Error('runaway retry loop'); w.sleeps.push(ms); w.t += ms; },
  });
  return w;
}
const fail = (m = 'boom') => new Error(m);

let pass = 0, failN = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`)) : (failN++, console.log(`  ✗ ${name}`)); }
  catch (e) { failN++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};

console.log('registration lifecycle (§5.12 D1–D4)');

await check('R1 a first boot: top-up 0.4 before register, validity from get_agent; registered and valid', async () => {
  const w = world({ balance: 0 });
  await w.reg.run(1);
  const iFund = w.calls.indexOf('fund:0.4'), iReg = w.calls.indexOf('register');
  return iFund >= 0 && iFund < iReg && w.reg.state.phase === 'registered'
    && w.reg.state.validUntilMs === T0 + 7 * DAY && w.reg.isValid();
});

await check('R2 D4: funds 0.4 below 0.35, nothing at 0.35', async () => {
  const a = world({ balance: 0.349 }); await a.reg.run(1);
  const b = world({ balance: 0.35 }); await b.reg.run(1);
  return R.AGENT_MIN_BALANCE_NEAR === 0.35 && R.AGENT_FUND_NEAR === 0.4
    && a.calls.includes('fund:0.4') && !b.calls.some((c) => c.startsWith('fund'));
});

await check('R3 D3: backoff 10 s, 20 s, 40 s, 80 s; a top-up precedes every attempt', async () => {
  const w = world({ balance: 1, register: [fail(), fail(), fail(), fail(), true] });
  await w.reg.run(1);
  const seq = w.calls.filter((c) => c === 'balance' || c === 'register');
  const alternates = seq.length === 10 && seq.every((c, i) => c === (i % 2 ? 'register' : 'balance'));
  return JSON.stringify(w.sleeps.slice(0, 4)) === JSON.stringify([10_000, 20_000, 40_000, 80_000]) && alternates;
});

await check('R4 D3: the backoff is capped at 10 min', async () => {
  const w = world({ balance: 1, register: [...Array(9).fill(fail()), true] });
  await w.reg.run(1);
  return JSON.stringify(w.sleeps.slice(0, 9)) === JSON.stringify([10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000, 600_000]);
});

await check('R5 D3: "not enough balance … 0.306": failed top-up, then a top-up in the loop, then registered', async () => {
  const w = world({
    balance: 0.1, fundFails: 1,
    register: [(x) => { if (x.balance < 0.306) throw fail('does not have enough balance 0.1 for operation costing 0.306'); return true; }],
  });
  await w.reg.run(1);
  return w.calls.filter((c) => c === 'fund:0.4').length === 2 && w.reg.state.phase === 'registered' && w.reg.isValid();
});

await check('R6 no sponsor: never funds, still retries', async () => {
  const w = world({ balance: 0, hasSponsor: false, register: [fail(), fail(), true] });
  await w.reg.run(1);
  return !w.calls.some((c) => c.startsWith('fund') || c === 'balance') && w.calls.filter((c) => c === 'register').length === 3;
});

await check('R7 not whitelisted → no register, retried; null (TEE required) → registers', async () => {
  const w = world({ balance: 1, whitelisted: (x) => (x.calls.filter((c) => c === 'isWhitelisted').length < 3 ? false : null) });
  await w.reg.run(1);
  const firstReg = w.calls.indexOf('register');
  const wlBefore = w.calls.slice(0, firstReg).filter((c) => c === 'isWhitelisted').length;
  return wlBefore === 3 && w.sleeps.length >= 2 && w.reg.state.phase === 'registered';
});

await check('R8 D2: a lagging view (absent, then the previous expiry) is not taken; the fresh one is', async () => {
  const w = world({ balance: 1, views: [null, (x) => ({ validity: 'Valid', valid_until_ms: String(x.t + 6 * 3600_000) }),
    (x) => ({ validity: 'Valid', valid_until_ms: String(x.t + 7 * DAY) })] });
  await w.reg.run(1);
  return w.calls.filter((c) => c === 'view:get_agent').length === 3 && w.reg.state.validUntilMs === w.t + 7 * DAY;
});

await check('R9 D2: validity never readable → null (never guessed); not valid; next cycle in 6 days', async () => {
  const w = world({ balance: 1, views: [fail('rpc down')] });
  await w.reg.run(1);
  return w.reg.state.phase === 'registered' && w.reg.state.validUntilMs === null && !w.reg.isValid()
    && w.reg.nextDelayMs() === 6 * DAY && w.calls.filter((c) => c === 'view:get_agent').length === 6;
});

await check('R10 D2: not valid once the contract\'s expiry has passed', async () => {
  const w = world({ balance: 1 });
  await w.reg.run(1);
  const before = w.reg.isValid(); w.t = w.reg.state.validUntilMs + 1;
  return before && !w.reg.isValid();
});

await check('R11 D1: the next cycle starts one day before the contract\'s expiry (5-day validity → 4 days)', async () => {
  const w = world({ balance: 1, views: [(x) => ({ validity: 'Valid', valid_until_ms: String(x.t + 5 * DAY) })] });
  await w.reg.run(2);
  return w.sleeps.length === 1 && w.sleeps[0] === 4 * DAY && w.calls.filter((c) => c === 'register').length === 2;
});

await check('R12 D1: a failing re-registration retries with backoff until it succeeds', async () => {
  const w = world({ balance: 1, register: [true, fail(), fail(), fail(), true] });
  await w.reg.run(2);
  const firstUntil = T0 + 7 * DAY;
  return JSON.stringify(w.sleeps) === JSON.stringify([6 * DAY, 10_000, 20_000, 40_000])
    && w.reg.state.validUntilMs === w.t + 7 * DAY && w.reg.state.validUntilMs > firstUntil;
});

await check('R13 a funding error is not fatal: register is still attempted', async () => {
  const w = world({ balance: 0.5, fundFails: 99 });
  w.balance = 0.2; // under the minimum; every fund() fails
  await w.reg.run(1);
  return w.calls.includes('fund:0.4') && w.calls.includes('register') && w.reg.state.phase === 'registered';
});

await check('R14 success clears last_error; failed attempts counted per cycle', async () => {
  const w = world({ balance: 1, register: [fail('x'), false, true] });
  const seen = [];
  const orig = w.agent.register;
  w.agent.register = async () => { seen.push(w.reg.state.lastError); return orig(); };
  await w.reg.run(1);
  return JSON.stringify(seen) === JSON.stringify([null, 'x', 'register() returned false'])
    && w.reg.state.lastError === null && w.reg.state.attempts === 2;
});

await check('I1 index.ts: healthy only via isValid(), valid_until_ms reported, the old fixed loops gone', async () => {
  const src = readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8');
  return /status: registrar\?\.isValid\(\) && hasMasterSeed\(\) \? "healthy" : "degraded"/.test(src)
    && /valid_until_ms: validUntilMs/.test(src) && /await registrar\.run\(\)/.test(src)
    && !/setInterval/.test(src) && !/Waiting for whitelist/.test(src);
});

console.log(`\n${pass}/${pass + failN} passed`);
process.exit(failN ? 1 : 0);

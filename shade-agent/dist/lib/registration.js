// shade-agent/src/lib/registration.ts
//
// §5.12 D1–D4: the agent's registration lifecycle, out of index.ts so it can be
// harnessed (test/test-registration.mjs) with a fake agent, clock and sleep.
//
//   D1 Re-registration RETRIES. It used to be one attempt every 6 days: a single
//      failure left the agent to expire at 7 days. Now each cycle retries until
//      it succeeds, and the next cycle is timed from the contract's own
//      `valid_until_ms` (one day before it), not from a fixed interval.
//   D2 `/` reflects validity: index.ts reports `valid_until_ms`, and `healthy`
//      requires it to be in the future (state.validUntilMs, read from get_agent).
//   D3 Backoff and top-up IN the loop. Every attempt first tops the agent up,
//      then waits 10 s, 20 s, 40 s … capped at 10 min between failures. Before,
//      a too-small balance failed every 10 s forever without a new top-up.
//   D4 Funding covers register()'s 300 Tgas pre-charge (≈0.306 NEAR must be on
//      the account to SEND the call, though ~0.02 is burned): top up to cover it
//      when the balance is under 0.35 NEAR, by sending 0.4 NEAR.
//
// Every boot inside the TEE is a NEW random agent; its balance is stranded at
// the next restart. The sponsor (nova-sponsor.near) must hold ≥0.4 NEAR per
// expected restart.
export const AGENT_MIN_BALANCE_NEAR = 0.35;
export const AGENT_FUND_NEAR = 0.4;
export const RETRY_FIRST_MS = 10_000;
export const RETRY_MAX_MS = 10 * 60_000;
export const REREGISTER_BEFORE_EXPIRY_MS = 24 * 60 * 60_000; // one day of margin on 7-day validity
export const REREGISTER_FALLBACK_MS = 6 * 24 * 60 * 60_000; // if valid_until_ms could not be read
const msg = (e) => (e instanceof Error ? e.message : String(e));
export function createRegistrar(deps) {
    const now = deps.now ?? (() => Date.now());
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const log = deps.log ?? (() => { });
    const { agent } = deps;
    const state = {
        phase: 'registering', registeredAt: null, validUntilMs: null, lastError: null, attempts: 0,
    };
    /** D3/D4: fund when under the minimum. Never fatal: registration may still pass. */
    async function topUp() {
        if (!deps.hasSponsor)
            return;
        try {
            const balance = await agent.balance();
            if (balance < AGENT_MIN_BALANCE_NEAR) {
                log('info', 'agent_funding', { balance, amount: AGENT_FUND_NEAR });
                await agent.fund(AGENT_FUND_NEAR);
            }
        }
        catch (e) {
            log('warn', 'agent_funding_failed', { message: msg(e) });
        }
    }
    /**
     * D2: the contract's own validity for this agent, after a registration. A view
     * may lag the transaction (absent for a new agent, the previous expiry for a
     * re-registration), so only a Valid entry expiring more than a day from now
     * counts as THIS registration; otherwise read again, up to 6 times, 10 s apart.
     * Never guessed: unreadable ⇒ null (health stays degraded).
     */
    async function readValidUntil() {
        for (let i = 0; i < 6; i++) {
            try {
                const v = await agent.view({ methodName: 'get_agent', args: { account_id: agent.accountId() } });
                const until = v && v.validity === 'Valid' && v.valid_until_ms !== undefined ? Number(v.valid_until_ms) : NaN;
                if (Number.isFinite(until) && until > now() + REREGISTER_BEFORE_EXPIRY_MS)
                    return until;
            }
            catch (e) {
                log('warn', 'agent_validity_read_failed', { message: msg(e) });
            }
            await sleep(RETRY_FIRST_MS);
        }
        log('error', 'agent_validity_unknown', { account_id: agent.accountId() });
        return null;
    }
    /** D1/D3: one cycle — retry with backoff until register() succeeds. */
    async function registerUntilDone() {
        let wait = RETRY_FIRST_MS;
        state.attempts = 0;
        for (;;) {
            await topUp();
            try {
                const whitelisted = await agent.isWhitelisted(); // null = the contract requires a TEE
                if (whitelisted === null || whitelisted) {
                    if (await agent.register()) {
                        state.phase = 'registered';
                        state.registeredAt = new Date(now()).toISOString();
                        state.lastError = null;
                        state.validUntilMs = await readValidUntil();
                        log('info', 'agent_registered', { valid_until_ms: state.validUntilMs, attempts: state.attempts });
                        return;
                    }
                    state.lastError = 'register() returned false';
                }
                else {
                    state.lastError = 'agent not whitelisted';
                }
            }
            catch (e) {
                state.lastError = msg(e);
            }
            state.attempts++;
            log('error', 'agent_registration_error', { message: state.lastError, attempts: state.attempts, retry_in_ms: wait });
            await sleep(wait);
            wait = Math.min(wait * 2, RETRY_MAX_MS);
        }
    }
    /** When the next cycle starts: a day before expiry, or 6 days on if validity is unknown. */
    function nextDelayMs() {
        if (state.validUntilMs === null)
            return REREGISTER_FALLBACK_MS;
        return Math.max(RETRY_FIRST_MS, state.validUntilMs - REREGISTER_BEFORE_EXPIRY_MS - now());
    }
    /** Register, then keep re-registering before expiry. `cycles` bounds it for the harness. */
    async function run(cycles = Infinity) {
        for (let c = 0; c < cycles; c++) {
            await registerUntilDone();
            if (c + 1 < cycles)
                await sleep(nextDelayMs());
        }
    }
    /** D2: valid now, by the contract's own clock as last read. */
    const isValid = () => state.phase === 'registered' && state.validUntilMs !== null && state.validUntilMs > now();
    return { state, run, isValid, nextDelayMs, topUp };
}

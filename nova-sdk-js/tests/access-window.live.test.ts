// nova/nova-sdk-js/tests/access-window.live.test.ts
//
// §6.1 Piece 4 — LIVE access-window smoke (the "SDK path" step in the verify
// order: health → security invariant → happy path → SDK path).
//
// The hermetic tests (index.test.ts) prove the SDK sends access_minutes, validates
// it before any network call, and unwraps get_member_window. They cannot prove the
// one thing only production can: that a window sold through the SDK is actually
// ENFORCED — MCP records it before the add, Shade's scheduler revokes the member
// (signed as the owner inside the TEE) about a minute after expiry, and the window
// disappears.
//
// Against gmail-14.nova-sdk.near (custodial owner) on the reusable fixture group
// `retention-exec-fixture`, with the real NOVA_API_KEY from .env, it:
//   1. adds a throwaway member with { accessMinutes: 1 },
//   2. reads the window back (owner) and checks the member is authorized,
//   3. waits for the scheduler to revoke (≤ expiry + ~2.5 min),
//   4. checks the window is gone.
// Plus: a member with no window reads as null; invalid accessMinutes is refused.
//
// Requires: production Shade with SCHEDULER_ENABLED=true. Costs: one add
// (~0.0000129 NEAR fee) + one owner revoke (~0.000001 NEAR) + gas, paid by gmail-14.
// Self-skips without NOVA_API_KEY. Takes ~2–3 minutes.
//
// NOTE: deliberately no jest.mock('axios') — real network (mock scope is per-file).

import 'dotenv/config';
import { NovaSdk, NovaError } from '../src/index';

const ACCOUNT_ID = 'gmail-14.nova-sdk.near';
const GROUP = 'retention-exec-fixture';
const apiKey = process.env.NOVA_API_KEY;

const maybe = apiKey ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

maybe('§6.1 Piece 4 — live access-window smoke (SDK path)', () => {
  const sdk = new NovaSdk(ACCOUNT_ID, { apiKey: apiKey as string });
  const member = `aw-sdk-${Date.now()}.near`;

  beforeAll(async () => {
    // Fixture sanity: gmail-14 must own the group (free view, no fee).
    expect(await sdk.getGroupOwner(GROUP)).toBe(ACCOUNT_ID);
  });

  test('invalid accessMinutes is refused client-side (NovaError)', async () => {
    await expect(sdk.addGroupMember(GROUP, member, { accessMinutes: 0 })).rejects.toThrow(NovaError);
  });

  test('a member without a window reads as null', async () => {
    // The owner is a permanent member of its own group: no window.
    expect(await sdk.getMemberWindow(GROUP, ACCOUNT_ID)).toBeNull();
  });

  test(
    'a 1-minute window sold through the SDK is enforced: revoked at expiry, window removed',
    async () => {
      // 1. Sell the window.
      const msg = await sdk.addGroupMember(GROUP, member, { accessMinutes: 1 });
      expect(msg).toContain('with access until');

      // 2. Owner reads it back; the member has access now.
      const win = await sdk.getMemberWindow(GROUP, member);
      expect(win).not.toBeNull();
      const expiresMs = win!.expires_at_ms;
      expect(expiresMs).toBeGreaterThan(Date.now());
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + 65_000);
      expect(await sdk.isAuthorized(GROUP, member)).toBe(true);

      // 3. Wait for the scheduler: first tick after expiry (≤ 60 s) + revoke/rotate/
      //    complete (~10 s) + finality. Poll until revoked or the deadline passes.
      const deadline = expiresMs + 150_000;
      let revoked = false;
      while (Date.now() < deadline) {
        await sleep(10_000);
        if (!(await sdk.isAuthorized(GROUP, member))) { revoked = true; break; }
      }
      expect(revoked).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`✅ revoked ${Math.round((Date.now() - expiresMs) / 1000)}s after expiry`);

      // 4. The window entry is gone (completeAccessWindow ran after the revoke+rotate).
      let gone = false;
      for (let i = 0; i < 6 && !gone; i++) {
        gone = (await sdk.getMemberWindow(GROUP, member)) === null;
        if (!gone) await sleep(5_000);
      }
      expect(gone).toBe(true);
    },
    300_000, // live network + a real 1-minute window
  );
});
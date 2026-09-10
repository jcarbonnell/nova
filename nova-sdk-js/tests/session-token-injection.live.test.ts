// nova/nova-sdk-js/tests/session-token-injection.live.test.ts
//
// Phase 0.6 — LIVE injected-path smoke (the "SDK path" step in the verify order:
// health → security invariant → happy path → SDK path).
//
// The hermetic harness (session-token-injection.test.ts) proves the SDK BEHAVES
// correctly offline: injected token used verbatim, no mint, expired → dedicated
// error. It structurally cannot prove the one thing that only production can —
// that a token minted one way and injected another is actually ACCEPTED by MCP
// (verified against SESSION_TOKEN_SECRET / issuer / audience).
//
// This test does exactly that against gmail-14.nova-sdk.near using the real
// NOVA_API_KEY from .env. It:
//   1. mints a nova_session the normal apiKey way (one direct POST, the same
//      call the SDK's apiKey path makes),
//   2. injects that token into a SECOND SDK that has NO apiKey,
//   3. performs a real read (getOwnedGroups) through the injected path.
//
// Because sdkB carries NO apiKey, a pass can ONLY come from the injected token
// working: a broken injection would throw 'API key required' (never silently
// mint), so this cleanly isolates "MCP accepts an injected, non-self-minted
// session" from every other path.
//
// It is a SMOKE check, not a harness: it hits production MCP over the network
// and gates on "the happy path works", not on byte-identical behaviour. It
// self-skips when NOVA_API_KEY is absent, so it never breaks a keyless CI run.
//
// NOTE: this file deliberately does NOT jest.mock('axios') — it needs the real
// network. jest.mock scope is per-file, so the hermetic suite's mock does not
// leak here and this file's real axios does not leak there.

import 'dotenv/config';
import { NovaSdk } from '../src/index';
import axios from 'axios';

const AUTH_URL = 'https://nova-sdk.com';
const ACCOUNT_ID = 'gmail-14.nova-sdk.near';
const apiKey = process.env.NOVA_API_KEY;

// Gate: run only when a real key is present; skip cleanly otherwise.
const maybe = apiKey ? describe : describe.skip;

maybe('Phase 0.6 — live injected-path smoke (SDK path)', () => {
  test(
    'a session minted from an API key, injected into a second (key-less) SDK, is accepted by MCP',
    async () => {
      // 1. Mint a nova_session exactly as the SDK's apiKey path does.
      const mintRes = await axios.post(
        `${AUTH_URL}/api/auth/session-token`,
        { account_id: ACCOUNT_ID },
        {
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey as string },
          timeout: 15000,
        },
      );

      const token = mintRes.data?.token;
      expect(typeof token).toBe('string');
      expect((token as string).length).toBeGreaterThan(0);

      // Soft sanity: the mint should be for the account we asked about.
      if (mintRes.data?.account_id) {
        expect(mintRes.data.account_id).toBe(ACCOUNT_ID);
      }

      // 2. Inject that token into a SECOND SDK with NO apiKey — the dashboard's
      //    exact path. No apiKey means a pass can ONLY come from the injected
      //    token: a broken injection throws 'API key required', it never mints.
      const sdkB = new NovaSdk(ACCOUNT_ID, { sessionToken: token as string });

      // 3. Real read through the injected path. MCP verifies the nova_session;
      //    a non-error return proves MCP accepts a token the SDK did not mint.
      //    An empty array is a valid, passing answer (account may own no groups).
      const groups = await sdkB.getOwnedGroups();

      expect(Array.isArray(groups)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`✅ injected-path read OK — ${ACCOUNT_ID} owns ${groups.length} group(s)`);
    },
    30000, // live network: generous per-test timeout
  );
});
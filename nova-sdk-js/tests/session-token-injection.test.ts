// nova/nova-sdk-js/tests/session-token-injection.test.ts
//
// Phase 0.6 harness — SDK sessionToken injection (dashboard prerequisite).
//
// The dashboard's same-origin proxy mints a nova_session from the user's Auth0
// cookie and injects it; the SDK must use that token VERBATIM and never mint.
// This proves the auth change before any image/publish (§10 discipline).
//
// Decision (A), confirmed: an injected token whose JWT `exp` is in the past
// surfaces as a dedicated, offline-detectable error — it must NOT fall through
// to the apiKey mint path, even when an apiKey is also present. `refreshToken()`
// in injected mode throws the same error rather than silently no-op'ing.
//
// Cases:
//   1. injected (no exp)      → used verbatim, ZERO axios calls
//   2. injected (future exp)  → used verbatim, ZERO axios calls
//   3. injected (past exp)    → dedicated error, ZERO axios calls
//   4. apiKey path            → regression-clean (mints exactly once)
//   5. both apiKey+sessionToken → injected wins (ZERO mint calls)
//   6. neither                → existing 'API key required' (unchanged)
//   7. refreshToken injected  → dedicated error, ZERO axios calls
//
// This file is expected to be RED until the sessionToken field + getSessionToken
// guard land in src/index.ts. A harness that has never failed hasn't been shown
// to work — run it red first, then green after the edit.

import { NovaSdk, NovaError } from '../src/index';
import axios from 'axios';

jest.mock('axios');

const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockAxiosIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

const testAccountId = 'alice.nova-sdk.near';
const mockApiKey = 'nova_sk_mockapikey1234567890123456789012345678901';

// The dedicated error text for an expired injected token (Decision A).
const EXPIRED_MSG = 'Injected session token has expired';

const SESSION_TOKEN_URL_FRAGMENT = '/api/auth/session-token';

// ── JWT builder ────────────────────────────────────────────────────────────
// Minimal unsigned JWT (header.payload.sig). The SDK only decodes the payload
// segment to read `exp`; it never verifies the signature (MCP does that).
// `exp` is seconds-since-epoch per RFC 7519 — the SDK must treat it as seconds.
function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  return `${header}.${body}.sig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Token with no exp claim → not decodable as expiring → used verbatim.
const injectedNoExp = makeJwt({ account_id: testAccountId, type: 'nova_session' });
// Token valid for another hour → used verbatim.
const injectedFuture = makeJwt({ account_id: testAccountId, type: 'nova_session', exp: nowSec() + 3600 });
// Token that expired an hour ago → dedicated error.
const injectedExpired = makeJwt({ account_id: testAccountId, type: 'nova_session', exp: nowSec() - 3600 });

// A minted token, distinct from any injected one, so we can prove which path ran.
const mintedToken = 'eyJhbGciOiJIUzI1NiJ9.eyJtaW50ZWQiOnRydWV9.minted';

// Count only the calls that would hit the session-token mint endpoint.
function mintCalls(): unknown[][] {
  return mockAxiosPost.mock.calls.filter((c) =>
    String(c[0]).includes(SESSION_TOKEN_URL_FRAGMENT),
  );
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  mockAxiosIsAxiosError.mockImplementation(
    (e: unknown) => e !== null && typeof e === 'object' && 'isAxiosError' in e,
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Phase 0.6 — sessionToken injection', () => {
  // ── Case 1 ────────────────────────────────────────────────────────────────
  test('injected token (no exp) is used verbatim, no mint fires', async () => {
    const sdk = new NovaSdk(testAccountId, { sessionToken: injectedNoExp });

    // getSessionToken is private; reach it directly for an offline unit assertion.
    const token = await (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken();

    expect(token).toBe(injectedNoExp);
    expect(mintCalls().length).toBe(0);
    // Nothing at all should have been POSTed — pure offline path.
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Case 2 ────────────────────────────────────────────────────────────────
  test('injected token (future exp) is used verbatim, no mint fires', async () => {
    const sdk = new NovaSdk(testAccountId, { sessionToken: injectedFuture });

    const token = await (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken();

    expect(token).toBe(injectedFuture);
    expect(mintCalls().length).toBe(0);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Case 3 ────────────────────────────────────────────────────────────────
  test('injected token (past exp) throws the dedicated error, no mint fires', async () => {
    const sdk = new NovaSdk(testAccountId, { sessionToken: injectedExpired });

    await expect(
      (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken(),
    ).rejects.toThrow(EXPIRED_MSG);

    // Must be a NovaError, not a bare Error, so callers can catch it uniformly.
    await expect(
      (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken(),
    ).rejects.toBeInstanceOf(NovaError);

    expect(mintCalls().length).toBe(0);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Case 4 ────────────────────────────────────────────────────────────────
  test('apiKey path still mints (regression-clean)', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      status: 200,
      data: { token: mintedToken, expires_in: '24h', account_id: testAccountId },
    });

    const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey });
    const token = await (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken();

    expect(token).toBe(mintedToken);
    expect(mintCalls().length).toBe(1);
    // The mint POST carries the API key and the account id, exactly as before.
    const [url, body, cfg] = mockAxiosPost.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toContain(SESSION_TOKEN_URL_FRAGMENT);
    expect(body).toEqual({ account_id: testAccountId });
    expect(cfg.headers['X-API-Key']).toBe(mockApiKey);
  });

  // ── Case 5 ────────────────────────────────────────────────────────────────
  test('both apiKey and sessionToken → injected wins, no mint fires', async () => {
    // If the guard ordering is wrong this would mint; make a mint observable so
    // a regression is loud rather than silent.
    mockAxiosPost.mockResolvedValue({
      status: 200,
      data: { token: mintedToken, expires_in: '24h', account_id: testAccountId },
    });

    const sdk = new NovaSdk(testAccountId, { apiKey: mockApiKey, sessionToken: injectedNoExp });
    const token = await (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken();

    expect(token).toBe(injectedNoExp);
    expect(token).not.toBe(mintedToken);
    expect(mintCalls().length).toBe(0);
  });

  // ── Case 6 ────────────────────────────────────────────────────────────────
  test('neither apiKey nor sessionToken → existing API-key-required error', async () => {
    const sdk = new NovaSdk(testAccountId);

    await expect(
      (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken(),
    ).rejects.toThrow('API key required');

    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Case 7 ────────────────────────────────────────────────────────────────
  test('refreshToken() in injected mode throws the dedicated error (no silent no-op), no mint fires', async () => {
    // An expired injected token has nothing to refresh to; refreshToken must not
    // pretend success and must not fall through to minting.
    const sdk = new NovaSdk(testAccountId, { sessionToken: injectedExpired });

    await expect(sdk.refreshToken()).rejects.toThrow(EXPIRED_MSG);
    expect(mintCalls().length).toBe(0);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  // ── Case 7b (companion) ─────────────────────────────────────────────────────
  test('refreshToken() with a valid injected token resolves to the same token, no mint fires', async () => {
    // Refresh on a still-valid injected token is a no-op refresh: it must not
    // mint, and a subsequent getSessionToken still returns the injected token.
    const sdk = new NovaSdk(testAccountId, { sessionToken: injectedFuture });

    await expect(sdk.refreshToken()).resolves.toBeUndefined();
    const token = await (sdk as unknown as { getSessionToken(): Promise<string> }).getSessionToken();

    expect(token).toBe(injectedFuture);
    expect(mintCalls().length).toBe(0);
  });
});
// tests/no-secret-leak.test.ts — 1.4.1 harness: an SDK error never carries a credential.
//
// Every request below carries marker values in X-API-Key and Authorization, the
// same headers the real SDK sends. Each thrown error is serialised every way an
// app might log it (message, stack, String, JSON, util.inspect with hidden
// properties at full depth) and searched for the markers. L* cases go through the
// REAL NovaSdk with axios mocked; E* cases hit NovaError directly; M* cases prove
// the detector is not blind (they must find the marker in a raw axios error).
import { inspect } from 'node:util';
import axios from 'axios';
import { NovaSdk, NovaError } from '../src/index';
import { redact } from '../src/errors';

jest.mock('axios');
const mockPost = axios.post as jest.MockedFunction<typeof axios.post>;
const mockIsAxiosError = axios.isAxiosError as jest.MockedFunction<typeof axios.isAxiosError>;

const MARK = 'LEAKMARKER';
const API_KEY = `nova_sk_${MARK}0000000000000000000000000000000000`;
// Same header/payload shape as index.test.ts's mock session; the marker sits in the signature.
const SESSION = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Uubm92YS1zZGsubmVhciIsInR5cGUiOiJub3ZhX3Nlc3Npb24ifQ.${MARK}sig`;
const ACCOUNT = 'alice.nova-sdk.near';

/** An axios-shaped error whose config, request and response all carry the credential. */
function axiosError(status: number, body: object, headers: Record<string, string>) {
  const raw = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: `Request failed with status code ${status}`,
    config: { headers: { ...headers }, url: 'https://example.invalid/x' },
    request: { _header: `POST /x HTTP/1.1\r\n${raw}\r\n\r\n`, getHeaders: () => headers },
    response: { status, data: body, headers: {}, config: { headers: { ...headers } } },
    toJSON: () => ({ config: { headers } }),
  };
}

/** Every way an app might print or ship an error. */
const renderings = (e: unknown): string[] => {
  const err = e as Error & { cause?: unknown };
  return [
    String(err), err.message, String(err.stack),
    String(err.cause), JSON.stringify(err), JSON.stringify(err.cause ?? null),
    inspect(err, { depth: Infinity, showHidden: true }),
  ];
};
const leaks = (e: unknown) => renderings(e).filter((s) => s.includes(MARK)).length;

async function caught(fn: () => Promise<unknown>): Promise<NovaError> {
  try { await fn(); } catch (e) { return e as NovaError; }
  throw new Error('expected a throw');
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockIsAxiosError.mockImplementation((e: unknown) =>
    e !== null && typeof e === 'object' && 'isAxiosError' in (e as object));
});
afterEach(() => jest.restoreAllMocks());

describe('1.4.1: no credential in any SDK error', () => {
  test('L1 failed session fetch (401): API key nowhere, server reason kept', async () => {
    mockPost.mockRejectedValueOnce(axiosError(401, { error: 'Invalid API key' }, { 'X-API-Key': API_KEY }));
    const sdk = new NovaSdk(ACCOUNT, { apiKey: API_KEY });
    const err = await caught(() => sdk.getOwnedGroups());
    expect(err).toBeInstanceOf(NovaError);
    // callMcpTool wraps the session failure: the session fetch runs inside its try.
    expect(err.message).toBe("MCP tool 'get_owned_groups' failed: NovaError: Failed to get session token: Invalid API key");
    expect((err.cause as Error & { cause?: { status?: number } }).cause?.status).toBe(401);
    expect(leaks(err)).toBe(0);
  });

  test('L2 session fetch 404: same guarantee on the not-found branch', async () => {
    mockPost.mockRejectedValueOnce(axiosError(404, { error: 'not found' }, { 'X-API-Key': API_KEY }));
    const sdk = new NovaSdk(ACCOUNT, { apiKey: API_KEY });
    const err = await caught(() => sdk.getOwnedGroups());
    expect(err.message).toBe(`MCP tool 'get_owned_groups' failed: NovaError: Account '${ACCOUNT}' not found. Create one at nova-sdk.com first.`);
    expect(leaks(err)).toBe(0);
  });

  test('L3 failed MCP call (401): session token nowhere, server reason kept', async () => {
    mockPost
      .mockResolvedValueOnce({ status: 200, data: { token: SESSION, expires_in: '24h', account_id: ACCOUNT } })
      .mockRejectedValueOnce(axiosError(401, { error: 'Auth failed: invalid session token' },
        { Authorization: `Bearer ${SESSION}`, 'x-account-id': ACCOUNT }));
    const sdk = new NovaSdk(ACCOUNT, { apiKey: API_KEY });
    const err = await caught(() => sdk.getOwnedGroups());
    expect(err.message).toBe("MCP tool 'get_owned_groups' failed: Auth failed: invalid session token");
    expect((err.cause as { status?: number }).status).toBe(401);
    expect(leaks(err)).toBe(0);
  });

  test('L4 a server that echoes the credential in its error body is redacted too', async () => {
    mockPost.mockRejectedValueOnce(axiosError(400, { error: `bad key ${API_KEY}` }, { 'X-API-Key': API_KEY }));
    const sdk = new NovaSdk(ACCOUNT, { apiKey: API_KEY });
    const err = await caught(() => sdk.getOwnedGroups());
    expect(err.message).toContain('[redacted]');
    expect(leaks(err)).toBe(0);
  });

  test('E1 a benign Error cause is kept by identity (existing contract)', () => {
    const cause = new Error('network unreachable');
    expect(new NovaError('x', cause).cause).toBe(cause);
  });

  test('E2 an Error cause whose message carries a key-like URL is replaced by a redacted copy', () => {
    const cause = new Error(`fetch failed for https://rpc.example.invalid/?apiKey=${MARK}xyz`);
    const err = new NovaError('rpc failed', cause);
    expect(err.cause).not.toBe(cause);
    expect(err.cause?.message).toBe('fetch failed for https://rpc.example.invalid/?apiKey=[redacted]');
    expect(leaks(err)).toBe(0);
  });

  test('E3 an Error wrapping a raw axios error is not kept', () => {
    const wrapper = Object.assign(new Error('signer failed'), {
      cause: axiosError(500, {}, { Authorization: `Bearer ${SESSION}` }),
    });
    const err = new NovaError('wallet call failed', wrapper);
    expect(leaks(err)).toBe(0);
  });

  test('E4 redact(): every credential shape', () => {
    expect(redact(`Authorization: Bearer ${SESSION}`)).toBe('Authorization: [redacted]');
    expect(redact(`key ${API_KEY} end`)).toBe('key [redacted] end');
    expect(redact(`tok ${SESSION} end`)).toBe('tok [redacted] end');
    expect(redact('u?a=1&api_key=s3cret&b=2')).toBe('u?a=1&api_key=[redacted]&b=2');
  });

  test('M1 the detector is not blind: a raw axios error as cause leaks through inspect', () => {
    const raw = Object.assign(new Error('pre-1.4.1 shape'), {
      cause: axiosError(401, {}, { 'X-API-Key': API_KEY }),
    });
    expect(leaks(raw)).toBeGreaterThan(0);
  });
});

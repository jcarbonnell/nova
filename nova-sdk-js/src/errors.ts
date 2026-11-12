// nova-sdk-js/src/errors.ts
//
// NovaError never carries a credential (1.4.1, §5.12 item 10).
//
// Before 1.4.1 the constructor stored whatever it was given as `cause`. For an
// HTTP failure that was the axios error, whose config/request carry the
// request headers: `X-API-Key` (session fetch) and `Authorization: Bearer
// <session>` (MCP calls). Node prints the whole cause chain when an error
// escapes, so any app that logged an SDK error published its user's API key or
// session. Now:
//   - an axios cause becomes a plain HttpError { name, message, status, error },
//     read from the response BODY only — never config, request or headers;
//   - any other Error cause is kept as-is (identity) unless its message, stack
//     or nested cause could carry a credential, in which case a redacted copy
//     replaces it;
//   - every string NovaError keeps is redacted for Bearer tokens, NOVA API keys,
//     JWTs and key-like URL query parameters.
// Harness: tests/no-secret-leak.test.ts.

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /nova_sk_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /([?&](?:api_?key|key|token|access_token)=)[^&\s"'`]+/gi,
];

/** Replace anything credential-shaped in a string. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (s, re) => s.replace(re, (m, qp?: string) =>
      typeof qp === 'string' && m.startsWith(qp) ? `${qp}[redacted]` : '[redacted]'),
    text,
  );
}

const hasSecret = (s: unknown): boolean =>
  typeof s === 'string' && SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(s); });

interface AxiosLike {
  isAxiosError: true;
  message?: string;
  response?: { status?: number; data?: unknown };
}
const isAxiosLike = (e: unknown): e is AxiosLike =>
  !!e && typeof e === 'object' && (e as { isAxiosError?: unknown }).isAxiosError === true;

/** What an HTTP failure becomes: status and the server's own error text, nothing else. */
export interface HttpCause extends Error {
  name: 'HttpError';
  status?: number;
  error?: string;
}

function httpCause(e: AxiosLike): HttpCause {
  const data = e.response?.data as { error?: unknown; message?: unknown } | undefined;
  const body = typeof data?.error === 'string' ? data.error
    : typeof data?.message === 'string' ? data.message : undefined;
  const status = e.response?.status;
  const cause = new Error(redact(`HTTP ${status ?? 'request'} failed${body ? `: ${body}` : ''}`)) as HttpCause;
  cause.name = 'HttpError';
  if (status !== undefined) cause.status = status;
  if (body !== undefined) cause.error = redact(body);
  cause.stack = `${cause.name}: ${cause.message}`; // no frames: they add nothing here
  return cause;
}

/** True when an Error (and its cause chain, up to 4 levels) can be kept as-is. */
function isSafe(e: unknown, depth = 0): boolean {
  if (e === undefined || e === null) return true;
  if (depth > 4 || isAxiosLike(e)) return false;
  if (!(e instanceof Error)) return !hasSecret(String(e));
  return !hasSecret(e.message) && !hasSecret(e.stack)
    && isSafe((e as { cause?: unknown }).cause, depth + 1);
}

function safeCause(c: unknown): Error | undefined {
  if (c === undefined || c === null) return undefined;
  if (isAxiosLike(c)) return httpCause(c);
  if (c instanceof Error && isSafe(c)) return c;
  if (c instanceof Error) {
    const copy = new Error(redact(c.message));
    copy.name = c.name;
    copy.stack = `${copy.name}: ${copy.message}`;
    return copy;
  }
  return new Error(redact(String(c)));
}

export class NovaError extends Error {
  public cause?: Error;

  constructor(message: string, cause?: unknown) {
    super(redact(message));
    this.name = 'NovaError';
    this.cause = safeCause(cause);
  }
}

// test-scrubber-apikey.mjs
// Run: npx tsx test-scrubber-apikey.mjs
// Proves the 8.1a logger scrubs the FastNear ?apiKey= secret from every
// string-valued log path — and documents (as failing-if-changed tripwires)
// the nested paths that BYPASS scrub, so no future call site logs them.

import { log } from './src/lib/logger.js';

const KEY = '1c672d81273933a3796fc79be9b75e7485462be5d8ec23285d7a37dd0c5c5978';
const AUTHED_URL = `https://rpc.mainnet.fastnear.com?apiKey=${KEY}`;

let pass = 0, fail = 0;
const captured = [];
const realError = console.error, realWarn = console.warn, realInfo = console.info;
function hook() {
  console.error = (s) => captured.push(s);
  console.warn = (s) => captured.push(s);
  console.info = (s) => captured.push(s);
}
function unhook() {
  console.error = realError; console.warn = realWarn; console.info = realInfo;
}
function lastLine() { return captured[captured.length - 1] || ''; }
function assert(cond, msg) {
  if (cond) { pass++; realInfo(`  ✅ ${msg}`); }
  else { fail++; realInfo(`  ❌ ${msg}`); }
}
function keyLeaked() { return lastLine().includes(KEY); }

// ── 1. The primary path: axios error .message containing the authed URL ──────
// This is what kv.ts / near.ts actually log: message: (err as Error).message
hook();
{
  const errLikeConnRefused = `connect ECONNREFUSED ${AUTHED_URL}`;
  log('warn', 'kv_get_failed', { key_id_hash: 'abc123', message: errLikeConnRefused });
  unhook();
  assert(!keyLeaked(), 'axios .message with ?apiKey= URL → key scrubbed');
  assert(lastLine().includes('apiKey=[REDACTED]'), 'redaction marker present (delimiter preserved)');
  hook();
}
unhook();

// ── 2. &apiKey= (not leading ?) ──────────────────────────────────────────────
hook();
{
  log('warn', 'x', { message: `failed https://host/path?finality=final&apiKey=${KEY}` });
  unhook();
  assert(!keyLeaked(), '&apiKey= (mid-query) → scrubbed');
  hook();
}
unhook();

// ── 3. viewFunction's real site: rpc_error = JSON.stringify(errorObject) ──────
// near.ts logs: rpc_error: JSON.stringify(response.data.error). Simulate an
// error object whose text embeds the authed URL, then stringified.
hook();
{
  const errObj = { name: 'TimeoutError', detail: `upstream ${AUTHED_URL} timed out` };
  log('warn', 'view_call_rpc_error', {
    contract_id: 'nova-sdk.near',
    method: 'is_authorized',
    rpc_error: JSON.stringify(errObj),
  });
  unhook();
  assert(!keyLeaked(), 'JSON.stringify(errorObject) containing URL → scrubbed');
  hook();
}
unhook();

// ── 4. URL embedded in JSON with trailing quote (char-class boundary) ─────────
hook();
{
  log('warn', 'x', { message: `{"url":"${AUTHED_URL}","status":401}` });
  unhook();
  assert(!keyLeaked(), 'URL inside JSON string (trailing ") → scrubbed');
  hook();
}
unhook();

// ── 5. Bearer form (if FastNear ever used as Authorization header) ────────────
hook();
{
  log('warn', 'x', { message: `sent Authorization: Bearer ${KEY} to upstream` });
  unhook();
  assert(!keyLeaked(), 'Bearer <key> → scrubbed');
  hook();
}
unhook();

// ── 6. TRIPWIRE: nested object bypasses scrub (redact is shallow BY DESIGN) ───
// This asserts the DANGER, not safety: it proves that logging the axios error
// OBJECT (or err.config) leaks the key, because redact() passes non-string
// top-level values through untouched. If this ever starts passing (key NOT
// found), redact became recursive and these call sites became safe — update the
// test. Until then: NEVER log err, err.config, or err.response in these routes.
hook();
{
  const fakeAxiosErr = { message: 'Request failed with status code 401', config: { url: AUTHED_URL } };
  log('warn', 'x', { error: fakeAxiosErr });   // <-- the forbidden pattern
  unhook();
  assert(keyLeaked(), 'TRIPWIRE: logging the error OBJECT leaks key (redact is shallow) — never do this');
  hook();
}
unhook();

// ── 7. TRIPWIRE: err.config.url as a top-level nested object ──────────────────
hook();
{
  log('warn', 'x', { config: { url: AUTHED_URL } });
  unhook();
  assert(keyLeaked(), 'TRIPWIRE: nested { config: { url } } leaks — pass err.message (string), not err.config');
  hook();
}
unhook();

// ── 8. Confirm the safe extraction of #6/#7: pass .message, not the object ────
// axios 401 .message does NOT contain the URL — so it is clean, but ALSO does not
// reveal which URL failed. Documents that on 4xx the key is safe precisely
// because .message omits the URL (the URL lives in err.config, which we must not log).
hook();
{
  const axios401Message = 'Request failed with status code 401';
  log('warn', 'kv_get_failed', { message: axios401Message });
  unhook();
  assert(!keyLeaked(), '401 .message (no URL) → nothing to leak');
  assert(!lastLine().includes('fastnear'), '401 .message reveals no URL at all (key safe, but URL invisible)');
  hook();
}
unhook();

realInfo(`\n${'─'.repeat(50)}`);
realInfo(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
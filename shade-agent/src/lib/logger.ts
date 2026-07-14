// shade-agent/src/lib/logger.ts
// Structured logging. Lifted verbatim from the identical copies previously
// inlined in routes/user-keys.ts and routes/key-management.ts.
//
// NOTE: this is the minimal extraction only — no behaviour change. The richer
// structured logging + PII redaction work (roadmap §4, observability) replaces
// this later; do not expand it here.

export function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta?: Record<string, unknown>,
) {
  console[level](JSON.stringify({ ts: new Date().toISOString(), level, event, ...meta }));
}

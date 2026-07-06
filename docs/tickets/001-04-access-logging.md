# Implement Access Logging & Audit Trail

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 for contract routes. Implements the structured audit trail per target-architecture.md §6. Access logging is a core product differentiator — it enables third-party verification of who accessed what, when.

### Overview
Implement the audit logging service (`api/src/services/audit-logger.ts`) that emits structured audit events for all key accesses, auth attempts, file operations, and group membership changes. Store events in PostgreSQL with a query endpoint. No PII — account IDs only.

### Acceptance Criteria

**Audit Logger (`api/src/services/audit-logger.ts`):**
- [ ] `logEvent(event: AuditEvent): Promise<void>` — persist structured audit event to PostgreSQL
- [ ] `queryAuditLog(filters: AuditQuery): Promise<{ data: AuditEvent[], meta }>` — query with filters
- [ ] Event types and fields per target-architecture.md §6:

| Event | Fields |
|---|---|
| `key_access` | key_type, resource_id, version, requested_by, auth_method, outcome |
| `key_rotation` | group_id, old_version, new_version, triggered_by, reason, rewrapped_count |
| `member_revoked` | group_id, member_id, new_version, rewrap_count |
| `auth_success` | auth_method, account_id |
| `auth_failure` | attempted_method, reason |
| `file_upload` | group_id, file_hash, version, uploaded_by |
| `file_retrieve` | group_id, file_hash, version, requested_by |
| `api_key_generated` | account_id, version |
| `api_key_used` | account_id, version, endpoint |

**Database Schema (`api/src/db/schema.ts`):**
- [ ] `audit_events` table:
  - `id (text, PK)` — UUID
  - `event_type (text, indexed)` — one of the event types above
  - `resource_type (text)` — e.g., "group_key", "file", "api_key"
  - `resource_id (text, indexed)` — the specific resource (group_id, file_hash, etc.)
  - `version (int, nullable)` — key version or file version
  - `requested_by (text, indexed)` — account ID of the actor
  - `auth_method (text)` — "siwn", "api_key", "session"
  - `outcome (text)` — "success" or specific error code
  - `metadata (jsonb)` — flexible payload for event-specific data
  - `created_at (timestamp, indexed)`
- [ ] Composite index on `(resource_id, event_type, created_at)` for common queries
- [ ] No PII in any column — account IDs only, no emails, no raw tokens, no IPs in metadata

**Emit Audit Events From Services:**
- [ ] `key-management.ts`: emit `key_access` on every key retrieval, `key_rotation` on rotation, `member_revoked` on revocation
- [ ] `file-storage.ts`: emit `file_upload` on upload, `file_retrieve` on retrieval
- [ ] `auth.ts`: emit `auth_success` on successful challenge verification, `auth_failure` on failed attempts, `api_key_used` on API key auth
- [ ] `api-key operations`: emit `api_key_generated` on creation
- [ ] Inject audit logger into services during `initialize` lifecycle

**Query Endpoint:**
- [ ] `getAuditLog` contract route with filters:
  - `resource_id` (optional) — filter by specific group or resource
  - `event_type` (optional) — filter by event type
  - `requested_by` (optional) — filter by actor
  - `from` / `to` (optional) — time range
  - `limit` (default 50, max 100), `cursor` — pagination
- [ ] Auth required: must be authenticated to query logs (group members can see their group's logs, owners can see all)
- [ ] Authorization check: if `resource_id` is provided, verify caller is a member of that group

**Cleanup & Retention:**
- [ ] Default retention: 90 days (configurable via env var)
- [ ] Cleanup can be a manual process or cron — not required for MVP
- [ ] No automatic deletion in MVP; add note for future cleanup

### Notes
- [ ] Audit events are fire-and-forget — logging failure should not block the primary operation
- [ ] Wrap `logEvent` calls in try/catch so a DB hiccup doesn't prevent a key retrieval
- [ ] Consider eventual consistency: if audit log write fails, at least log to structured console output as fallback
- [ ] The on-chain NEAR contract already records transactions as part of the immutable audit trail — this DB audit log is the fast query layer
- [ ] Follow the service factory pattern for `createAuditLogger(db)`
- [ ] Export audit types from the contract so UI can type query responses

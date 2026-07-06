# Access Logging, Audit Trail & Retention

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 for contract routes. Implements structured audit logging per target-architecture.md §6 plus per-group retention policies. Access logging is a core product differentiator — it enables third-party verification of who accessed what, when.

### Overview
Implement the audit logging service (`api/src/services/audit-logger.ts`) that emits structured audit events for all key accesses, auth attempts, file operations, and group membership changes. Store events in PostgreSQL with a query endpoint. Add per-group retention — permanent by default, optionally auto-expire after N days. No PII — account IDs only.

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

**Database Schema (`api/src/db/schema.ts`):**
- [ ] `audit_events` table:
  - `id (text, PK)` — UUID
  - `event_type (text, indexed)`
  - `resource_type (text)` — "group_key", "file", "group"
  - `resource_id (text, indexed)` — group_id, file_hash, etc.
  - `version (int, nullable)` — key or file version
  - `requested_by (text, indexed)` — account ID of the actor
  - `auth_method (text)` — "siwn", "api_key"
  - `outcome (text)` — "success" or error code
  - `metadata (jsonb)` — event-specific payload
  - `created_at (timestamp, indexed)`
- [ ] Composite index on `(resource_id, event_type, created_at)` for common queries
- [ ] No PII — account IDs only, no emails, no raw tokens

**Emit Audit Events From Services:**
- [ ] `key-management.ts` (#001-02): emit `key_access` on every key retrieval, `key_rotation` on rotation, `member_revoked` on revocation
- [ ] `file-storage.ts` (#001-03): emit `file_upload` on upload, `file_retrieve` on retrieval
- [ ] Log on auth events: `auth_success` on SIWN sign-in, `auth_failure` on failed attempts (integration with better-near-auth hooks if available, or in middleware)
- [ ] Inject audit logger into services during `initialize` lifecycle

**Query Endpoint:**
- [ ] `getAuditLog` contract route with filters: `resource_id`, `event_type`, `requested_by`, `from`/`to` time range, `limit` (default 50, max 100), `cursor`
- [ ] Auth required to query logs
- [ ] Authorization: if `resource_id` is provided, verify caller is a member of that group

**Per-Group Retention Policy:**
- [ ] Groups are **permanent by default** — no automatic deletion or expiry
- [ ] Group owners can configure a retention policy when creating or editing a group:

| Policy Field | Type | Default | Description |
|---|---|---|---|
| `retention_type` | `"permanent"` \| `"expire_after"` | `"permanent"` | Whether the group auto-expires |
| `retention_days` | `integer` | `null` | Number of days before expiry (required if `expire_after`) |
| `expire_action` | `"revoke_access"` \| `"delete_data"` | `"revoke_access"` | What happens on expiry |
| `expires_at` | `timestamp` | `null` | Computed as `created_at + retention_days` |

- [ ] **`revoke_access`**: remove all group members via contract `revoke_group_member` for each member, rotate group key (no one can access existing files)
- [ ] **`delete_data`**: same as revoke_access + delete encrypted file blobs from PostgreSQL — data is gone permanently
- [ ] Expiry check runs on group access or via scheduled background job
- [ ] Once expired, group is marked `expired: true` in DB — re-activation is possible (owner can extend expiry before it triggers)
- [ ] Expiry event is logged to audit trail
- [ ] Group owner can change the policy before expiry; extending the expiry window re-computes `expires_at`
- [ ] DB schema addition on groups table: `retention_type TEXT DEFAULT 'permanent'`, `retention_days INTEGER`, `expire_action TEXT DEFAULT 'revoke_access'`, `expires_at TIMESTAMP`, `expired BOOLEAN DEFAULT FALSE`

### Notes
- [ ] Audit events are fire-and-forget — logging failure should not block the primary operation
- [ ] Wrap `logEvent` calls in try/catch so a DB hiccup doesn't prevent a key retrieval; fall back to structured console log
- [ ] The on-chain `record_transaction` is the immutable audit trail — the DB audit log is the fast query layer
- [ ] Cleanup of old audit events is not required for MVP; add note for future retention TTL
- [ ] Follow the service factory pattern for `createAuditLogger(db)`
- [ ] Export audit types from the contract so UI can type query responses

# Encrypted File Operations

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 (contract + crypto) and #001-02 (key hierarchy), to implement end-to-end encrypted file upload, retrieval, and listing. This is where the system stores and retrieves encrypted data — the core product value prop.

### Overview
Implement the file storage service (`api/src/services/file-storage.ts`) that handles encrypted file upload and retrieval. Files are encrypted client-side with AES-256-GCM using a per-file key. The file key is wrapped with the group key and stored alongside the encrypted blob. Replace IPFS with PostgreSQL blob storage (with NEAR FastKV as an alternative backend). Every file operation records an on-chain transaction via `contract.record_transaction` for the immutable audit trail.

### Acceptance Criteria

**File Upload Flow:**
- [ ] `uploadFile(groupId: string, fileHash: string, encryptedBlob: Uint8Array, wrappedFileKey: string, uploaderAccountId: string): Promise<{ fileHash, storageRef, version }>`
- [ ] Accept encrypted file data (client already encrypted with per-file key)
- [ ] Accept wrapped file key (file key encrypted with group key)
- [ ] Hash verification: compute SHA-256 of encrypted blob, ensure it matches `fileHash`
- [ ] Store encrypted blob in PostgreSQL (`BYTEA` column)
- [ ] Store wrapped file key alongside blob
- [ ] Record on-chain transaction: `contract.record_transaction(groupId, uploaderAccountId, fileHash, storageRef)` — creates immutable audit trail. Fee: 0.002 NEAR. Note: contract param `ipfs_hash` is repurposed for our storage reference.
- [ ] Return `{ fileHash, storageRef, version }` where `version` is the current group key version
- [ ] Validate uploader is a group member (via contract `is_authorized` or DB mirror)

**File Retrieval Flow:**
- [ ] `retrieveFile(groupId: string, fileHash: string, requesterAccountId: string): Promise<{ encryptedBlob, wrappedFileKey, version, metadata }>`
- [ ] Verify requester is a group member
- [ ] Load encrypted blob from PostgreSQL
- [ ] Return encrypted blob + wrapped file key (client decrypts locally with file key)
- [ ] If stored file was encrypted with an older group key version, include version info
- [ ] Emit access log event

**File Listing:**
- [ ] `listFiles(groupId: string, requesterAccountId: string, options?: { limit?: number, cursor?: string }): Promise<{ data: FileInfo[], meta: { total, hasMore, nextCursor } }>`
- [ ] File metadata: `fileHash`, `storageRef`, `version`, `createdAt`, `uploadedBy`, `size`
- [ ] Query on-chain: `contract.get_transactions_for_group(groupId)` gets the immutable transaction log (0.0001 NEAR fee)
- [ ] Merge with DB metadata for richer display (size, etc.)
- [ ] Support pagination (default 50, max 100)
- [ ] Ordered by `created_at DESC`
- [ ] Require group membership

**File Re-wrapping (used during key rotation):**
- [ ] `rewrapFileKey(groupId: string, fileHash: string, oldGroupKey: Uint8Array, newGroupKey: Uint8Array): Promise<void>`
- [ ] Decrypt existing wrapped file key with old group key
- [ ] Re-encrypt file key with new group key
- [ ] Update stored wrapped file key in DB
- [ ] Update group key version on file record
- [ ] Called by key rotation service (#001-02) for each file in group

**Database Schema:**
- [ ] `files` table:
  - `id (text, PK)` — UUID
  - `group_id (text, indexed)`
  - `file_hash (text)`
  - `encrypted_blob (bytea)` — the encrypted file data
  - `wrapped_key (text)` — file key encrypted with group key (base64)
  - `group_key_version (int)` — which group key version was used to wrap
  - `size (int)` — approximate size in bytes
  - `created_at (timestamp)`
  - `uploaded_by (text)` — account ID
- [ ] Unique index on `(group_id, file_hash)`

**Data Storage Backend:**
- [ ] PostgreSQL `BYTEA` for blobs (encrypted file data)
- [ ] Storage interface abstracted for future backend swaps (FastKV, etc.):
  ```
  interface FileStorageBackend {
    store(key: string, data: Uint8Array): Promise<void>;
    retrieve(key: string): Promise<Uint8Array>;
    delete(key: string): Promise<void>;
  }
  ```
- [ ] PostgreSQL implementation as default

**Input Validation:**
- [ ] Account ID format: `^[a-z0-9._-]+\.(near|testnet)$`
- [ ] Group ID format: alphanumeric + `_` `-`, 1-64 chars
- [ ] `.safeParse()` pattern for all inputs — return `400` with `flatten()` errors if invalid

### Notes
- [ ] File encryption/decryption happens on the client — the server never sees plaintext
- [ ] The server stores only `encrypted_blob` and `wrapped_key` — no plaintext key material
- [ ] Contract `record_transaction` stores `group_id, user_id, file_hash, ipfs_hash` — we put our storage reference in the `ipfs_hash` field
- [ ] Consider adding a `filename` or `content_type` field for UI display (encrypted metadata stored alongside)
- [ ] Large file handling: if PostgreSQL `BYTEA` becomes a bottleneck, chunk files at ~1MB and store in `file_chunks` table
- [ ] Follow the service factory pattern from `createUpvoteService` in `api/src/index.ts`
- [ ] Export service types from contract so UI can use `Awaited<ReturnType<typeof apiClient.nova.uploadFile>>`

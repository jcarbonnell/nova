# Implement Encrypted File Operations

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 (contract + crypto) and #001-02 (key hierarchy), to implement end-to-end encrypted file upload, retrieval, and listing. This is where the system actually stores and retrieves encrypted data — the core product value prop.

### Overview
Implement the file storage service (`api/src/services/file-storage.ts`) that handles encrypted file upload and retrieval. Files are encrypted client-side with AES-256-GCM using a per-file key. The file key is wrapped with the group key and stored alongside the encrypted blob. Replace IPFS with PostgreSQL blob storage (with the option to swap to NEAR FastFS later).

### Acceptance Criteria

**File Upload Flow:**
- [ ] `uploadFile(groupId: string, fileHash: string, encryptedBlob: Uint8Array, wrappedFileKey: string, uploaderAccountId: string): Promise<{ fileHash, storageRef, version }>`
- [ ] Accept encrypted file data (client already encrypted with file key)
- [ ] Accept wrapped file key (file key encrypted with group key)
- [ ] Hash verification: compute SHA-256 of encrypted blob, ensure it matches `fileHash`
- [ ] Store encrypted blob in PostgreSQL (`BYTEA` column or chunked `TEXT` for large files)
- [ ] Store wrapped file key alongside blob
- [ ] Record transaction on NEAR contract: `record_transaction(group_id, file_hash, storage_ref)` for on-chain audit
- [ ] Return `{ fileHash, storageRef, version }` where `version` is the current group key version
- [ ] Validate uploader is a group member (auth middleware + group membership check)

**File Retrieval Flow:**
- [ ] `retrieveFile(groupId: string, fileHash: string, requesterAccountId: string): Promise<{ encryptedBlob, wrappedFileKey, version, metadata }>`
- [ ] Verify requester is a group member
- [ ] Load encrypted blob from PostgreSQL (or NEAR KV for files stored there)
- [ ] Return encrypted blob + wrapped file key (client decrypts)
- [ ] If stored file was encrypted with an older group key version, include version info so client can request the correct group key
- [ ] Emit access log event

**File Listing:**
- [ ] `listFiles(groupId: string, requesterAccountId: string, options?: { limit?: number, cursor?: string }): Promise<{ data: FileInfo[], meta: { total, hasMore, nextCursor } }>`
- [ ] File metadata: `fileHash`, `storageRef`, `version`, `createdAt`, `uploadedBy`, `size` (approximate blob size)
- [ ] Support pagination (default 50, max 100)
- [ ] Ordered by `created_at DESC`
- [ ] Require group membership

**File Re-wrapping (for key rotation):**
- [ ] `rewrapFileKey(groupId: string, fileHash: string, oldGroupKey: Uint8Array, newGroupKey: Uint8Array): Promise<void>`
- [ ] Decrypt existing wrapped file key with old group key
- [ ] Re-encrypt file key with new group key
- [ ] Update stored wrapped file key
- [ ] Called by key rotation service for each file in group

**Database Schema:**
- [ ] `files` table:
  - `id (text, PK)` — UUID
  - `group_id (text, indexed)`
  - `file_hash (text, unique per group)`
  - `encrypted_blob (bytea or text)` — the encrypted file data
  - `wrapped_key (text)` — file key encrypted with group key (base64)
  - `group_key_version (int)` — which group key version was used to wrap
  - `size (int)` — approximate size in bytes
  - `created_at (timestamp)`
  - `uploaded_by (text)` — account ID
- [ ] Unique index on `(group_id, file_hash)`

**Data Storage Backend:**
- [ ] PostgreSQL `BYTEA` for blobs up to ~10MB (typical encrypted file size)
- [ ] For larger files: chunked storage in a `file_chunks` table or NEAR KV
- [ ] File size limit: reject uploads over 50MB with `413 Payload Too Large`
- [ ] DB query for total storage per group (for usage display)
- [ ] Note: architecture supports swapping to NEAR FastFS later — keep storage interface abstracted

**API Routes (in `api/src/index.ts`):**
- [ ] `uploadFile` route: validate payload size, enforce auth + membership, call service
- [ ] `retrieveFile` route: enforce auth + membership, call service, return blob + wrapped key
- [ ] `listFiles` route: enforce auth + membership, call service with pagination
- [ ] Proper error responses: file not found → 404, not a member → 403, file too large → 413

### Notes
- [ ] File encryption/decryption happens on the client — the server never sees plaintext
- [ ] The server stores only `encrypted_blob` and `wrapped_key` — no plaintext key material in file storage
- [ ] Consider adding a `mime_type` or `filename` field for UI display (encrypted metadata or stored alongside)
- [ ] Large file handling: if PostgreSQL `BYTEA` becomes a bottleneck, chunk files at ~1MB and store in `file_chunks` table
- [ ] Eventually swap PostgreSQL blob storage for NEAR FastFS — design the storage service interface so the backend can be swapped: `interface FileStorageBackend { store(key, data): Promise<void>; retrieve(key): Promise<Uint8Array>; }`
- [ ] Follow the service factory pattern from `createUpvoteService` in `api/src/index.ts`
- [ ] Export service types from contract so UI can use `Awaited<ReturnType<typeof apiClient.nova.uploadFile>>`

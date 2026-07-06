# Migrate UI — Landing Page & Authenticated Dashboard

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 (contract typed surface) and #001-03 (file operations contract), to port the nova-landing UI into the everything-dev React 19 + TanStack Router framework. Blocked until the oRPC contract is defined so UI can consume typed API clients.

### Overview
Rebuild NOVA's landing page and create authenticated dashboard pages for group and file management. Follow everything-dev conventions: semantic Tailwind, kebab-case component naming, no comments in implementation, TanStack Router best practices, and TanStack Query for all data fetching.

### Acceptance Criteria

**Landing Page (`ui/src/routes/_layout/index.tsx`):**
- [ ] NOVA brand: logo, headline ("Verifiable, privacy-preserving shared storage"), subtitle
- [ ] Feature highlights: End-to-end encryption, On-chain access logs, Non-repudiation, Verifiable audit trail (pills/badges like nova-landing)
- [ ] Wallet connect button using better-auth SIWN flow
- [ ] Network indicator (Testnet / Mainnet)
- [ ] Responsive layout: hero section with branded gradient background
- [ ] Loading state while wallet initializes
- [ ] Redirect to `/groups` after successful auth
- [ ] Semantic Tailwind only (`bg-background`, `text-foreground`, `text-muted-foreground`, etc.)

**Authenticated Layout:**
- [ ] Reuse existing `_layout.tsx` sidebar and header (framework-provided)
- [ ] Add NOVA-specific navigation items in sidebar: Groups, Files, Settings
- [ ] Use the existing UserNav component for user menu

**Group Pages (`ui/src/routes/_layout/_authenticated/groups/`):**
- [ ] `groups/index.tsx` — list user's groups
  - Grid of `group-card` components showing group name, member count, file count, last activity
  - "Create Group" button → opens `group-form` dialog
  - Empty state: "No groups yet. Create your first shared encrypted workspace."
  - Loading skeleton while fetching
  - Uses `useOrpc()` for typed API calls
- [ ] `groups/$id.tsx` — group detail
  - Group name, owner, member count
  - Tab navigation: Files, Members, Activity Log
  - Files tab: `file-list` component with upload button
  - Members tab: `member-list` with add/remove (owner only)
  - Activity Log tab: audit log table filtered to this group
- [ ] `groups/$id.settings.tsx` — group settings
  - Danger zone: rotate key, delete group
  - Member management: add member (by NEAR account), view/revoke members

**File Management:**
- [ ] `file-upload.tsx` component
  - Drag-and-drop zone or file picker
  - Encrypt client-side using `api/src/lib/crypto.ts` patterns (ported to UI crypto utilities)
  - Progress indicator during encryption + upload
  - Calls `apiClient.nova.uploadFile()` via oRPC
  - File size validation (50MB max)
  - Loading/error states
- [ ] `file-list.tsx` component
  - Table of files: name/hash, uploaded by, date, size
  - Download button: retrieves encrypted blob → decrypts client-side → triggers download
  - Copy file hash button
  - Empty state: "No files uploaded yet."
  - Loading skeleton
- [ ] `file-download.tsx` flow
  - Client fetches encrypted blob + wrapped key via `apiClient.nova.retrieveFile()`
  - Client fetches group key via `apiClient.nova.getGroupKey()`
  - Client unwraps file key: `decryptBlob(wrappedKey, groupKey)`
  - Client decrypts file: `decryptBlob(encryptedBlob, fileKey)`
  - Triggers browser download via Blob URL

**Client-Side Crypto (`ui/src/lib/nova-crypto.ts`):**
- [ ] Port `api/src/lib/crypto.ts` AES-256-GCM encrypt/decrypt to Web Crypto API
- [ ] `encryptFile(plaintext: Uint8Array, key: Uint8Array): Promise<{ encrypted: Uint8Array, hash: string }>`
- [ ] `decryptFile(encrypted: Uint8Array, key: Uint8Array): Promise<Uint8Array>`
- [ ] `generateFileKey(): Promise<Uint8Array>` — crypto.getRandomValues(32)
- [ ] `sha256(data: Uint8Array): Promise<string>` — hex digest
- [ ] All crypto uses `window.crypto.subtle`

**Settings Pages:**
- [ ] Settings page with API key management
  - Generate new API key → display once → copy to clipboard
  - List existing keys (masked)
  - Rotate (generate new, invalidate old)
  - Delete API key

**Components to Create:**
- [ ] `nova-hero.tsx` — landing hero
- [ ] `wallet-connect-button.tsx` — NEAR wallet connection via better-auth SIWN
- [ ] `group-card.tsx` — group summary card
- [ ] `group-form.tsx` — create/edit group dialog
- [ ] `file-upload.tsx` — encrypted file upload
- [ ] `file-list.tsx` — file listing table
- [ ] `member-list.tsx` — member management
- [ ] `add-member-dialog.tsx` — add member dialog
- [ ] `audit-log-table.tsx` — audit event table
- [ ] All components exported from `ui/src/components/index.ts`
- [ ] All component filenames use lowercase kebab-case

**Data Fetching Patterns:**
- [ ] Use `useOrpc()` for all API calls — no raw `fetch()`
- [ ] Prefetch data in route `loader` (not `beforeLoad`) per TanStack Router best practices
- [ ] Use `router.invalidate()` after mutations that affect other routes
- [ ] Optimistic updates where appropriate (e.g., file upload appears immediately)
- [ ] Proper loading skeletons, empty states, and error boundaries for every page
- [ ] Types inferred from contract: `Awaited<ReturnType<typeof apiClient.nova.uploadFile>>`

### Notes
- [ ] Do NOT migrate the chat interface, MCP tool calls, or AI SDK — out of scope
- [ ] Do NOT migrate Auth0 login flow — use better-auth SIWN only
- [ ] Do NOT migrate the PaymentModal / on-ramp — out of scope for MVP
- [ ] Reuse existing shadcn-style UI components from `ui/src/components/ui/`
- [ ] Follow the `about.tsx` route as a reference for page structure patterns
- [ ] Tailwind: use semantic classes from `styles.css` (`bg-background`, `text-card-foreground`, etc.)
- [ ] Run `bun run typecheck` after component creation to catch type errors early
- [ ] File encryption is CPU-intensive — show progress indicator and use `requestIdleCallback` for large files

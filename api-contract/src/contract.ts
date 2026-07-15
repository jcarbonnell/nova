// nova/api-contract/src/contract.ts - NOVA's public wire protocol (MCP v19 /tools/*).
import { oc } from '@orpc/contract';
import { z } from 'zod';

const GroupId = z.string();
// A member/account id is a string; server-side normalization adds the suffix
// ("john" → "john.nova-sdk.near"), so we don't constrain format here.
const AccountId = z.string();

// ── shared result shapes ─────────────────────────────────────────────────────

// Message ops (register/add/revoke) return a bare human-readable string.
const MessageResult = z.string();

// Transaction shape: four fields confirmed on an older build; on-chain struct
// unchanged since. .passthrough() so v0.5 additions (location/backend/deleted)
// surface without false-failing; a MISSING declared field still fails.
const Transaction = z
  .object({
    group_id: z.string(),
    user_id: z.string(),
    file_hash: z.string(),
    ipfs_hash: z.string(),
  })
  .passthrough();

// ── get_owned_groups ─────────────────────────────────────────────────────────
// Live-proven 2026-07-15: body {}, response { result: string[] }.
export const getOwnedGroups = oc
  .route({ method: 'POST', path: '/tools/get_owned_groups', summary: 'List groups the authenticated account owns' })
  .input(z.object({}))
  .output(z.object({ result: z.array(GroupId) }));

// ── auth_status ──────────────────────────────────────────────────────────────
// Live-proven 2026-07-15. authorized_for_group present only when group_id !=
// "default"; auth_error present only on RPC failure (handler branch, not observed).
export const authStatus = oc
  .route({ method: 'POST', path: '/tools/auth_status', summary: 'Report authentication and (optionally) group authorization' })
  .input(z.object({ group_id: z.string().default('test_group') }))
  .output(
    z.object({
      result: z.object({
        authenticated: z.boolean(),
        near_account_id: z.string(),
        group_id: z.string(),
        authorized_for_group: z.boolean().optional(),
        auth_error: z.string().optional(),
      }),
    }),
  );

// ── get_member_groups ────────────────────────────────────────────────────────
// Same shape as get_owned_groups; groups the account is a member of.
export const getMemberGroups = oc
  .route({ method: 'POST', path: '/tools/get_member_groups', summary: 'List groups the authenticated account is a member of' })
  .input(z.object({}))
  .output(z.object({ result: z.array(GroupId) }));

// ── get_group_members ────────────────────────────────────────────────────────
// Confirmed via --write sweep (requires authorization on the group).
export const getGroupMembers = oc
  .route({ method: 'POST', path: '/tools/get_group_members', summary: 'List members of a group' })
  .input(z.object({ group_id: GroupId }))
  .output(z.object({ result: z.array(AccountId) }));

// ── get_group_transactions ───────────────────────────────────────────────────
// Confirmed via --write sweep. Unauthorized callers get a 500 NEAR panic, not [].
export const getGroupTransactions = oc
  .route({ method: 'POST', path: '/tools/get_group_transactions', summary: 'List a group’s file transactions (audit trail)' })
  .input(z.object({ group_id: GroupId }))
  .output(z.object({ result: z.array(Transaction) }));

// ── register_group ───────────────────────────────────────────────────────────
// MUTATING (~0.65 NEAR). Caller becomes owner.
export const registerGroup = oc
  .route({ method: 'POST', path: '/tools/register_group', summary: 'Register a group (caller becomes owner)' })
  .input(z.object({ group_id: GroupId }))
  .output(z.object({ result: MessageResult }));

// ── add_group_member ─────────────────────────────────────────────────────────
// MUTATING. member_id is suffix-normalized server-side.
export const addGroupMember = oc
  .route({ method: 'POST', path: '/tools/add_group_member', summary: 'Grant a member access to a group' })
  .input(z.object({ group_id: GroupId, member_id: AccountId }))
  .output(z.object({ result: MessageResult }));

// ── revoke_group_member ──────────────────────────────────────────────────────
// MUTATING. On success returns a confirmation string. NOTE: as of 2026-07-15 the
// live endpoint 500s (Shade broadcastContractCall: BigInt(undefined) at
// near.js:109 on the revoke path) — roadmap Step 7. Output schema below is the
// intended success shape, DESCRIBED but not yet confirmed against a 200.
export const revokeGroupMember = oc
  .route({ method: 'POST', path: '/tools/revoke_group_member', summary: 'Revoke a member from a group' })
  .input(z.object({ group_id: GroupId, member_id: AccountId }))
  .output(z.object({ result: MessageResult }));

// ── prepare_upload ───────────────────────────────────────────────────────────
// Requires group authorization. Returns the group AES key for client-side E2E.
export const prepareUpload = oc
  .route({ method: 'POST', path: '/tools/prepare_upload', summary: 'Begin an upload; returns the group key + upload_id' })
  .input(z.object({ group_id: GroupId, filename: z.string() }))
  .output(
    z.object({
      result: z.object({
        upload_id: z.string(),
        key: z.string(),
        group_id: z.string(),
        filename: z.string(),
      }),
    }),
  );

// ── finalize_upload ──────────────────────────────────────────────────────────
// MUTATING. Needs a live upload_id from prepare_upload. file_hash is 64-char hex
// (server rejects otherwise). trans_id arrives quote-wrapped; z.string() accepts it.
export const finalizeUpload = oc
  .route({ method: 'POST', path: '/tools/finalize_upload', summary: 'Store ciphertext + record the transaction on-chain' })
  .input(
    z.object({
      upload_id: z.string(),
      encrypted_data: z.string(),
      file_hash: z.string().regex(/^[a-fA-F0-9]{64}$/, 'file_hash must be 64-char hex (SHA-256)'),
    }),
  )
  .output(
    z.object({
      result: z.object({
        cid: z.string(),
        trans_id: z.string(),
        file_hash: z.string(),
      }),
    }),
  );

// ── prepare_retrieve ─────────────────────────────────────────────────────────
// Requires group authorization. ipfs_hash must be a CID (Qm… or bafy…).
export const prepareRetrieve = oc
  .route({ method: 'POST', path: '/tools/prepare_retrieve', summary: 'Fetch ciphertext + the group key for decryption' })
  .input(
    z.object({
      group_id: GroupId,
      ipfs_hash: z.string().regex(/^(Qm|bafy)/, 'ipfs_hash must be an IPFS CID'),
    }),
  )
  .output(
    z.object({
      result: z.object({
        key: z.string(),
        encrypted_b64: z.string(),
        ipfs_hash: z.string(),
        group_id: z.string(),
      }),
    }),
  );

// ── contract router ──────────────────────────────────────────────────────────
export const contract = {
  getOwnedGroups,
  authStatus,
  getMemberGroups,
  getGroupMembers,
  getGroupTransactions,
  registerGroup,
  addGroupMember,
  revokeGroupMember,
  prepareUpload,
  finalizeUpload,
  prepareRetrieve,
};

export type NovaContract = typeof contract;
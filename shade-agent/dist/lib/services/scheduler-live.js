// shade-agent/src/lib/services/scheduler-live.ts
//
// §6.1 Piece 4 — S3.3: LIVE wiring for the pure scheduler (scheduler.ts).
// Maps each SchedulerDeps effect to the real, already-harnessed service:
//   window sweep → access-windows (S1), signAsOwner (S2), rotateGroupKey,
//                  is_authorized / get_group_owner views (viewOrThrow: an RPC
//                  error THROWS, never reads as "not a member").
//   retention    → scanRetention / executeRetention (Pieces 2–3) + a KV marker.
//
// ENV is read LAZILY (inside functions): ESM imports evaluate before index.ts runs
// dotenv.config(), so module-level reads could see an empty environment.
//   SCHEDULER_ENABLED     — ON only when exactly 'true'. Anything else: OFF.
//   SCHEDULER_MARKER_KEY  — override of the retention marker key (harness only).
import { initializeMasterSeed } from '../seed.js';
import { getBlobFromKVStrict, storeBlobToKV } from '../kv.js';
import { encryptBlob, decryptBlob } from '../crypto.js';
import { getRpcUrl, resolveContract } from '../near.js';
import { signAsOwner } from '../owner-signer.js';
import { listDueWindows, completeAccessWindow } from './access-windows.js';
import { viewOrThrow, scanRetention, executeRetention } from './retention.js';
import { rotateGroupKey } from './key-management.js';
import { createScheduler } from './scheduler.js';
const markerKey = () => process.env.SCHEDULER_MARKER_KEY || 'scheduler-last-retention';
export const schedulerEnabled = () => process.env.SCHEDULER_ENABLED === 'true';
function rpcFor(contractId) {
    return getRpcUrl(resolveContract(contractId).network);
}
export function liveSchedulerDeps() {
    return {
        now: () => Date.now(),
        init: async () => { await initializeMasterSeed(); },
        listDueWindows: (nowMs) => listDueWindows(nowMs),
        isMember: async (w) => (await viewOrThrow(rpcFor(w.contract_id), w.contract_id, 'is_authorized', { group_id: w.group_id, user_id: w.member_id })) === true,
        groupOwner: async (w) => {
            const owner = await viewOrThrow(rpcFor(w.contract_id), w.contract_id, 'get_group_owner', { group_id: w.group_id });
            return typeof owner === 'string' && owner ? owner : null;
        },
        revokeAsOwner: async (ownerAccountId, w) => {
            await signAsOwner({
                owner_account_id: ownerAccountId,
                method_name: 'revoke_group_member',
                args: { group_id: w.group_id, user_id: w.member_id },
                contract_id: w.contract_id,
            });
        },
        rotateKey: async (w) => {
            await rotateGroupKey({ group_id: w.group_id, contract_id: w.contract_id });
        },
        completeWindow: (w) => completeAccessWindow(w),
        scanRetention: () => scanRetention({}),
        executeRetention: (groupId) => executeRetention({ group_id: groupId, confirm: true }),
        readRetentionMarker: async () => {
            const blob = await getBlobFromKVStrict(markerKey()); // throws on RPC error
            if (!blob)
                return null;
            const parsed = JSON.parse(Buffer.from(decryptBlob(blob)).toString('utf8'));
            return typeof parsed?.date === 'string' ? parsed.date : null;
        },
        writeRetentionMarker: async (utcDate) => {
            await storeBlobToKV(markerKey(), encryptBlob(Buffer.from(JSON.stringify({ date: utcDate }), 'utf8')));
        },
    };
}
// ── Process-wide singleton ──
let instance = null;
export function getScheduler() {
    if (!instance)
        instance = createScheduler(liveSchedulerDeps(), { enabled: schedulerEnabled() });
    return instance;
}
/** Called once from index.ts right after serve(). No-op (logs scheduler_disabled) unless enabled. */
export function startScheduler() {
    return getScheduler().start();
}
export function getSchedulerStatus() {
    return getScheduler().getStatus();
}

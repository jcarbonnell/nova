// shade-agent/src/lib/near-key-lookup.ts
//
// The TYPED key lookup that agent-identity.ts's verifier depends on.
//
// WHY NOT rpcCallWithRetry (lib/kv.ts): it flattens every RPC error into
// `Error("RPC error: <message>")`, so "this account does not exist" and "the RPC
// is down" become indistinguishable strings — and it retries definitive answers
// three times with backoff. The implicit-account branch must open ONLY on a
// positive UNKNOWN_ACCOUNT, so this module reads the structured `error.cause.name`
// itself. kv.ts is a live signing path and is NOT touched.
//
// CONTRACT (see KeyLookup in agent-identity.ts): answer only from a definitive
// RPC reply; everything else THROWS (the verifier maps a throw to
// KEY_LOOKUP_UNAVAILABLE / 503, and consumes nothing).
//
//   1. view_account          → ok: exists | cause UNKNOWN_ACCOUNT: { no_account }
//   2. view_access_key_list  → the account's full key list; the signing key is
//      matched by its DECODED BYTES. Absent from the list → { no_access_key }.
//
// WHY THE LIST, NOT view_access_key: FastNear (mainnet, verified 2026-10-14)
// reports a missing key the legacy way — HTTP 200 with `result.error` holding
// English text ("access key … does not exist while viewing"), no typed cause.
// Parsing that text would make an auth decision depend on a provider's wording.
// The list answers structurally: the key is in it or it is not.
//
// Read-only. No keys, no seed, no KV.
import { parsePublicKey } from 'near-kit';
export class KeyLookupUnavailable extends Error {
    constructor(detail) {
        super(`key lookup unavailable: ${detail}`);
        this.name = 'KeyLookupUnavailable';
    }
}
/** One transport retry; a parsed body (even an RPC error) is never retried. */
async function query(post, url, params) {
    const body = { jsonrpc: '2.0', id: 'agent-identity', method: 'query', params };
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await post(url, body);
            if (!res || typeof res !== 'object')
                throw new KeyLookupUnavailable('non-object body');
            return res;
        }
        catch (e) {
            if (e instanceof KeyLookupUnavailable)
                throw e;
            last = e;
        }
    }
    throw new KeyLookupUnavailable(`transport: ${last?.message ?? String(last)}`);
}
function causeName(b) {
    const n = b.error?.cause?.name;
    return typeof n === 'string' ? n : undefined;
}
export function makeKeyLookup(opts) {
    const { rpcUrl, post } = opts;
    return async (accountId, publicKey) => {
        // 1. does the account exist?
        const acct = await query(post, rpcUrl, {
            request_type: 'view_account', finality: 'final', account_id: accountId,
        });
        if (acct.error !== undefined) {
            if (causeName(acct) === 'UNKNOWN_ACCOUNT')
                return { kind: 'no_account' };
            throw new KeyLookupUnavailable(`view_account cause=${causeName(acct) ?? 'none'}`);
        }
        if (!acct.result || typeof acct.result.amount !== 'string') {
            throw new KeyLookupUnavailable('view_account: unexpected result shape');
        }
        // 2. the account's key list; match the signing key by decoded bytes
        const want = parsePublicKey(publicKey); // caller (the verifier) already validated it
        const list = await query(post, rpcUrl, {
            request_type: 'view_access_key_list', finality: 'final', account_id: accountId,
        });
        if (list.error !== undefined) {
            throw new KeyLookupUnavailable(`view_access_key_list cause=${causeName(list) ?? 'none'}`);
        }
        const keys = list.result?.keys;
        if (!Array.isArray(keys) || list.result?.error !== undefined) {
            throw new KeyLookupUnavailable('view_access_key_list: unexpected result shape');
        }
        for (const entry of keys) {
            if (typeof entry?.public_key !== 'string') {
                throw new KeyLookupUnavailable('view_access_key_list: entry without public_key');
            }
            let got;
            try {
                got = parsePublicKey(entry.public_key);
            }
            catch {
                continue;
            } // a key type we cannot parse is not ours
            if (got.keyType !== want.keyType || !sameBytes(got.data, want.data))
                continue;
            const perm = entry.access_key?.permission;
            if (perm === 'FullAccess')
                return { kind: 'access_key', permission: 'FullAccess' };
            if (perm && typeof perm === 'object' && 'FunctionCall' in perm) {
                return { kind: 'access_key', permission: 'FunctionCall' };
            }
            throw new KeyLookupUnavailable('view_access_key_list: unknown permission shape');
        }
        return { kind: 'no_access_key' };
    };
}
function sameBytes(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}

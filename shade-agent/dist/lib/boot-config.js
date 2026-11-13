// shade-agent/src/lib/boot-config.ts
//
// §5.12 (2026-11 incident rebuild): Shade's boot-time environment, validated in
// one pure function so the rules are testable (index.ts only calls it).
//
// Required: AGENT_CONTRACT_ID, KV_CONTRACT_ID, AUTH0_DOMAIN, AUTH0_AUDIENCE and
//           TEE_KEY_SECRET (64 hex chars: the root secret that decrypts
//           `master-root`; portable design, roadmap §5.12).
// No defaults (§5.12 hardening): a missing value refuses boot rather than fall
//           back to an old host or contract. KV_CONTRACT_ID may never be the
//           pre-switch nova-kv.near (lib/legacy.ts reads it, under the old secret);
//           AUTH0_AUDIENCE must be an https URL.
// Retired:  MASTER_SEED_INIT_ALLOWED. Shade never creates the master seed (the
//           operator writes it, lib/seed.ts), so the flag means nothing; if it is
//           still set, boot is REFUSED in production so it cannot linger unnoticed.
// Optional: SPONSOR_ACCOUNT_ID + SPONSOR_PRIVATE_KEY, both or neither. The
//           sponsor only funds the agent account. It must be a dedicated small
//           account: never the KV owner / NOVA contract (nova-sdk.near), never
//           the agent contract, never the KV contract. No server holds a key
//           for those accounts any more.
//
// Harness: test/test-boot-config.mjs.
export class BootConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BootConfigError';
    }
}
const RETIRED_VARIABLES = ['MASTER_SEED_INIT_ALLOWED'];
/** The pre-switch KV (lib/legacy.ts LEGACY_KV_CONTRACT; test-boot-config pins the two equal). */
export const PRE_SWITCH_KV_CONTRACT = 'nova-kv.near';
export function validateBootEnv(env) {
    const agentContractId = env.AGENT_CONTRACT_ID;
    const kvContractId = env.KV_CONTRACT_ID;
    const auth0Domain = env.AUTH0_DOMAIN;
    const auth0Audience = env.AUTH0_AUDIENCE;
    const missing = [
        ['AGENT_CONTRACT_ID', agentContractId],
        ['KV_CONTRACT_ID', kvContractId],
        ['AUTH0_DOMAIN', auth0Domain],
        ['AUTH0_AUDIENCE', auth0Audience],
        ['TEE_KEY_SECRET', env.TEE_KEY_SECRET],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
        throw new BootConfigError(`Missing required environment variables: ${missing.join(', ')}`);
    }
    if (kvContractId === PRE_SWITCH_KV_CONTRACT) {
        throw new BootConfigError(`KV_CONTRACT_ID must not be the pre-switch ${PRE_SWITCH_KV_CONTRACT}`);
    }
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(auth0Audience) || auth0Audience.endsWith('/')) {
        throw new BootConfigError('AUTH0_AUDIENCE must be an https URL without a trailing slash');
    }
    if (!/^[0-9a-f]{64}$/i.test(env.TEE_KEY_SECRET)) {
        throw new BootConfigError('TEE_KEY_SECRET must be a 64-char hex string');
    }
    const isProduction = env.NODE_ENV === 'production';
    const leftovers = RETIRED_VARIABLES.filter((k) => env[k] !== undefined && env[k] !== '');
    if (isProduction && leftovers.length) {
        throw new BootConfigError(`Retired variable(s) still set: ${leftovers.join(', ')}. Shade never creates the master seed; ` +
            'remove them from the CVM environment.');
    }
    const sponsorId = env.SPONSOR_ACCOUNT_ID;
    const sponsorKey = env.SPONSOR_PRIVATE_KEY;
    if (!!sponsorId !== !!sponsorKey) {
        throw new BootConfigError('SPONSOR_ACCOUNT_ID and SPONSOR_PRIVATE_KEY must be set together, or not at all');
    }
    const forbidden = new Set([
        env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near',
        env.NOVA_MAINNET_CONTRACT || 'nova-sdk.near',
        env.NOVA_TESTNET_CONTRACT,
        agentContractId,
        kvContractId,
    ].filter((a) => !!a));
    if (sponsorId && forbidden.has(sponsorId)) {
        throw new BootConfigError(`SPONSOR_ACCOUNT_ID must be a dedicated funding account, not ${sponsorId}`);
    }
    return {
        agentContractId: agentContractId,
        kvContractId: kvContractId,
        auth0Domain: auth0Domain,
        auth0Audience: auth0Audience,
        network: agentContractId.endsWith('.testnet') ? 'testnet' : 'mainnet',
        isProduction,
        sponsor: sponsorId ? { accountId: sponsorId, privateKey: sponsorKey } : null,
    };
}

// shade-agent/src/lib/config.ts
// Single source for network/contract configuration.
// SECRETS ARE DELIBERATELY ABSENT. Since §5.12 no root secret lives in the
// environment: root keys come from the TEE (lib/tee-keys.ts). The optional sponsor
// key (a dedicated funding account) is read only by lib/boot-config.ts.
// No throws at module load: this module must stay importable by
// scripts/generate-openapi.ts, which has no production .env.
export const NEAR_RPC_URL = process.env.NEAR_RPC_URL || 'https://rpc.mainnet.fastnear.com';
export const NEAR_TESTNET_RPC_URL = process.env.NEAR_TESTNET_RPC_URL || 'https://rpc.testnet.fastnear.com';
export function getRpcUrl(network) {
    return network === 'testnet' ? NEAR_TESTNET_RPC_URL : NEAR_RPC_URL;
}
// KV is SINGLE-NETWORK by design — nova-kv.near has no testnet counterpart.
export const KV_RPC_URL = NEAR_RPC_URL;
export const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
export const KV_CONTRACT_OWNER = process.env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near';
// Names match docker-compose. The pre-config code had FOUR names for these two
// values (NOVA_CONTRACT_ID/NOVA_MAINNET_CONTRACT, ..._TESTNET_CONTRACT_ID/...).
export const NOVA_MAINNET_CONTRACT = process.env.NOVA_MAINNET_CONTRACT || 'nova-sdk.near';
export const NOVA_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT || 'nova-sdk-7.testnet';
// Agent Connect identity sign-in (phase-2 bridge): the NEAR account NOVA names as
// `audience` / NEP-413 recipient in the challenges it issues. Agent owners must
// list it in their policy's `sign.recipients`. Validated on first use (not at
// load — see the no-throw rule above); always mainnet (the Agent API is).
export const AGENT_IDENTITY_RECIPIENT = process.env.AGENT_IDENTITY_RECIPIENT || 'nova-sdk.near';
// Written by bootstrapAgent() AFTER module load (7.5) — must be a getter.
export function shadeAgentAccountId() {
    return process.env.SHADE_AGENT_ACCOUNT_ID;
}

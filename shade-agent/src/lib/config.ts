// shade-agent/src/lib/config.ts
// Single source for network/contract configuration.
// SECRETS ARE DELIBERATELY ABSENT — TEE_KEY_SECRET and SPONSOR_PRIVATE_KEY stay
// read at their point of use. They feed decryptBlob and master-seed derivation;
// index.ts already fail-fasts on them at boot. Moving them buys nothing and
// risks the one key path that cannot be recovered.
// No throws at module load: this module must stay importable by
// scripts/generate-openapi.ts, which has no production .env.

export const NEAR_RPC_URL =
  process.env.NEAR_RPC_URL || 'https://rpc.mainnet.fastnear.com';
export const NEAR_TESTNET_RPC_URL =
  process.env.NEAR_TESTNET_RPC_URL || 'https://rpc.testnet.fastnear.com';

export function getRpcUrl(network: string): string {
  return network === 'testnet' ? NEAR_TESTNET_RPC_URL : NEAR_RPC_URL;
}

// KV is SINGLE-NETWORK by design — nova-kv.near has no testnet counterpart.
export const KV_RPC_URL = NEAR_RPC_URL;
export const KV_CONTRACT = process.env.KV_CONTRACT_ID || 'nova-kv.near';
export const KV_CONTRACT_OWNER = process.env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near';

// Names match docker-compose. The pre-config code had FOUR names for these two
// values (NOVA_CONTRACT_ID/NOVA_MAINNET_CONTRACT, ..._TESTNET_CONTRACT_ID/...).
export const NOVA_MAINNET_CONTRACT = process.env.NOVA_MAINNET_CONTRACT || 'nova-sdk.near';
export const NOVA_TESTNET_CONTRACT = process.env.NOVA_TESTNET_CONTRACT || 'nova-sdk-6.testnet';

// Written by bootstrapAgent() AFTER module load (7.5) — must be a getter.
export function shadeAgentAccountId(): string | undefined {
  return process.env.SHADE_AGENT_ACCOUNT_ID;
}
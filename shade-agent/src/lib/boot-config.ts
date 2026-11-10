// shade-agent/src/lib/boot-config.ts
//
// §5.12 (2026-11 incident rebuild): Shade's boot-time environment, validated in
// one pure function so the rules are testable (index.ts only calls it).
//
// Required: AGENT_CONTRACT_ID, KV_CONTRACT_ID, AUTH0_DOMAIN.
// Gone:     TEE_KEY_SECRET and MASTER_SEED_INIT_ALLOWED (root keys come from the
//           TEE, lib/tee-keys.ts). If either is still set, boot is REFUSED in
//           production: a leftover root secret in the environment is exactly
//           what this rebuild removes, and must not linger unnoticed.
// Optional: SPONSOR_ACCOUNT_ID + SPONSOR_PRIVATE_KEY, both or neither. The
//           sponsor only funds the agent account. It must be a dedicated small
//           account: never the KV owner / NOVA contract (nova-sdk.near), never
//           the agent contract, never the KV contract. No server holds a key
//           for those accounts any more.
//
// Harness: test/test-boot-config.mjs.

export interface BootConfig {
  agentContractId: string;
  kvContractId: string;
  auth0Domain: string;
  network: 'mainnet' | 'testnet';
  isProduction: boolean;
  sponsor: { accountId: string; privateKey: string } | null;
}

export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootConfigError';
  }
}

type Env = Record<string, string | undefined>;

const RETIRED_ROOT_SECRETS = ['TEE_KEY_SECRET', 'MASTER_SEED_INIT_ALLOWED'] as const;

export function validateBootEnv(env: Env): BootConfig {
  const agentContractId = env.AGENT_CONTRACT_ID;
  const kvContractId = env.KV_CONTRACT_ID;
  const auth0Domain = env.AUTH0_DOMAIN;
  const missing = [
    ['AGENT_CONTRACT_ID', agentContractId],
    ['KV_CONTRACT_ID', kvContractId],
    ['AUTH0_DOMAIN', auth0Domain],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new BootConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const isProduction = env.NODE_ENV === 'production';
  const leftovers = RETIRED_ROOT_SECRETS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (isProduction && leftovers.length) {
    throw new BootConfigError(
      `Retired root secret(s) still set: ${leftovers.join(', ')}. Root keys come from the TEE; ` +
        'remove them from the CVM environment.',
    );
  }

  const sponsorId = env.SPONSOR_ACCOUNT_ID;
  const sponsorKey = env.SPONSOR_PRIVATE_KEY;
  if (!!sponsorId !== !!sponsorKey) {
    throw new BootConfigError('SPONSOR_ACCOUNT_ID and SPONSOR_PRIVATE_KEY must be set together, or not at all');
  }
  const forbidden = new Set(
    [
      env.KV_CONTRACT_OWNER_ID || 'nova-sdk.near',
      env.NOVA_MAINNET_CONTRACT || 'nova-sdk.near',
      env.NOVA_TESTNET_CONTRACT,
      agentContractId,
      kvContractId,
    ].filter((a): a is string => !!a),
  );
  if (sponsorId && forbidden.has(sponsorId)) {
    throw new BootConfigError(
      `SPONSOR_ACCOUNT_ID must be a dedicated funding account, not ${sponsorId}`,
    );
  }

  return {
    agentContractId: agentContractId!,
    kvContractId: kvContractId!,
    auth0Domain: auth0Domain!,
    network: agentContractId!.endsWith('.testnet') ? 'testnet' : 'mainnet',
    isProduction,
    sponsor: sponsorId ? { accountId: sponsorId, privateKey: sponsorKey! } : null,
  };
}

/**
 * Network configuration for dual mainnet/testnet support
 */

export interface NetworkConfig {
  networkId: 'mainnet' | 'testnet';
  rpcUrl: string;
  novaContractId: string;
  agentContractId: string;
}

const MAINNET_CONFIG: NetworkConfig = {
  networkId: 'mainnet',
  rpcUrl: 'https://rpc.mainnet.near.org',
  novaContractId: process.env.NOVA_MAINNET_CONTRACT || 'nova-sdk.near',
  agentContractId: process.env.AGENT_MAINNET_CONTRACT || 'shade-agent.nova-sdk.near',
};

const TESTNET_CONFIG: NetworkConfig = {
  networkId: 'testnet',
  rpcUrl: 'https://rpc.testnet.near.org',
  novaContractId: process.env.NOVA_TESTNET_CONTRACT || 'nova-sdk-6.testnet',
  agentContractId: process.env.AGENT_TESTNET_CONTRACT || 'shade-agent.nova-sdk.testnet',
};

/**
 * Detect network from NEAR account ID
 * @param accountId - NEAR account (e.g., "alice.near" or "bob.testnet")
 * @returns NetworkConfig for detected network
 */
export function getNetworkConfig(accountId: string | null | undefined): NetworkConfig {
  if (!accountId) {
    // Default to mainnet if no account provided
    console.log('⚠️  No account ID provided, defaulting to mainnet');
    return MAINNET_CONFIG;
  }

  const lowerAccount = accountId.toLowerCase();
  
  // Check for .testnet suffix
  if (lowerAccount.endsWith('.testnet')) {
    console.log(`🔵 Detected testnet from account: ${accountId}`);
    return TESTNET_CONFIG;
  }

  // Everything else is mainnet (.near or implicit accounts)
  console.log(`🟢 Detected mainnet from account: ${accountId}`);
  return MAINNET_CONFIG;
}

/**
 * Get both network configs (for operations that need both)
 */
export function getAllNetworkConfigs(): {
  mainnet: NetworkConfig;
  testnet: NetworkConfig;
} {
  return {
    mainnet: MAINNET_CONFIG,
    testnet: TESTNET_CONFIG,
  };
}
// api-contract/src/index.ts
//
// Public entry point for @nova-sdk/contract. Re-exports the contract (the wire
// description) and the client factory (the way to call it) so consumers get
// both from the package root: import { createNovaClient, contract } from '@nova-sdk/contract'

export { contract, type NovaContract } from './contract.js';
export {
  createNovaClient,
  type NovaClient,
  type NovaClientOptions,
} from './client.js';
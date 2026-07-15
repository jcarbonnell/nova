import type { ContractRouterClient } from '@orpc/contract';
import { type NovaContract } from './contract.js';
export interface NovaClientOptions {
    /** A nova_session JWT, or an (async) getter returning one. The caller owns
     *  token lifecycle; an API-key→token flow belongs outside this package. */
    token: string | (() => string | Promise<string>);
    /** MCP base URL. Defaults to production. */
    mcpUrl?: string;
    /** Injectable fetch for tests / non-browser runtimes. */
    fetch?: (input: Request) => Promise<Response>;
}
export type NovaClient = ContractRouterClient<NovaContract>;
/**
 * Create a typed NOVA client over the public MCP surface.
 *
 * @example
 *   const nova = createNovaClient({ token: process.env.NOVA_SESSION_TOKEN! });
 *   const { result } = await nova.getOwnedGroups({});
 *
 * @example  // API-key flow lives outside; pass a getter:
 *   const nova = createNovaClient({ token: () => sdk.getSessionToken() });
 */
export declare function createNovaClient(options: NovaClientOptions): NovaClient;
export { contract } from './contract.js';
export type { NovaContract } from './contract.js';

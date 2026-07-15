// api-contract/src/client.ts
//
// Publishable typed client (D4). Consumers: `npm install @nova-sdk/contract`,
// then createNovaClient({ token }) and call NOVA with full type inference from
// the contract.
//
// PURE MCP SURFACE. This client only knows the /tools/* wire protocol described
// by ./contract. It does NOT mint tokens — turning an API key into a nova_session
// is the caller's job (nova-sdk-js already does it), passed in via `token`.
//
// token accepts either:
//   • a string        — a nova_session JWT the caller already holds, or
//   • a () => string | Promise<string>  — a getter, so an API-key flow can live
//     OUTSIDE this package and refresh transparently (pass () => sdk.getToken()).
//
// Transport: OpenAPILink, pointed at MCP. Whether OpenAPILink's dialect matches
// FastMCP's POST /tools/{name} + { result } body is proven by a live one-op call
// through this client (test/harness.mjs client case) — not assumed here.
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from './contract.js';
const DEFAULT_MCP_URL = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';
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
export function createNovaClient(options) {
    const { token, mcpUrl = DEFAULT_MCP_URL, fetch } = options;
    const resolveToken = async () => typeof token === 'function' ? token() : token;
    const link = new OpenAPILink(contract, {
        url: mcpUrl,
        fetch,
        headers: async () => ({
            Authorization: `Bearer ${await resolveToken()}`,
        }),
    });
    return createORPCClient(link);
}
export { contract } from './contract.js';

// shade-agent/scripts/generate-openapi.ts
//
// Emits TWO specs from the same router:
//
//   openapi.internal.json  — every procedure. For us and the frontend's typed
//                            client. Contains `retrieve`, which returns a PRIVATE
//                            KEY. Committed, but NEVER served publicly.
//
//   openapi.json           — filtered: procedures tagged `internal` are removed.
//                            Since the Shade Agent's whole API is behind the
//                            X-Internal-Auth gate, EVERY procedure is tagged
//                            internal — so this spec is empty BY CONSTRUCTION.
//                            That is the point: it makes "no key material in a
//                            public document" a build-time guarantee rather than
//                            a review-time hope. The real public spec is the NOVA
//                            contract (step 6.3), which describes MCP /tools/*.
//
// Run:  npx tsx scripts/generate-openapi.ts

import { writeFileSync } from 'fs';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { router } from '../src/rpc/router.js';

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const info = {
  title: 'NOVA Shade Agent (internal)',
  version: '0.4.0',
  description:
    'Internal key-management API. Every endpoint requires the X-Internal-Auth ' +
    'shared secret and is reachable only by the MCP server and the nova-landing ' +
    'server-side routes. NOT a public API.',
};

const internalSpec = await generator.generate(router, { info });
writeFileSync('openapi.internal.json', JSON.stringify(internalSpec, null, 2));

const publicSpec = await generator.generate(router, {
  info: { ...info, title: 'NOVA Shade Agent (public)' },
  // The tag is the guard. If a procedure ever loses it, it lands in the public
  // spec — which is exactly the failure this filter is designed to make loud.
  filter: ({ contract }) => !contract['~orpc'].route.tags?.includes('internal'),
});
writeFileSync('openapi.json', JSON.stringify(publicSpec, null, 2));

const publicPaths = Object.keys(publicSpec.paths ?? {});
console.log(`✅ openapi.internal.json — ${Object.keys(internalSpec.paths ?? {}).length} paths`);
console.log(`✅ openapi.json          — ${publicPaths.length} paths`);

if (publicPaths.length > 0) {
  console.error('\n❌ The PUBLIC spec is not empty. Paths leaked:', publicPaths);
  console.error("   Every Shade Agent procedure must carry tags: ['internal'].");
  process.exit(1);
}
console.log('\n   (public spec empty by design — the Shade Agent has no public API)');

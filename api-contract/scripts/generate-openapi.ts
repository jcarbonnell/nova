// api-contract/scripts/generate-openapi.ts
//
// Generates openapi.json from the contract — the public, honest description of
// NOVA's MCP /tools/* wire protocol. Run: npm run openapi
//
// SECURITY NOTE: this surface intentionally documents a base64 group `key`
// (prepare_upload / prepare_retrieve return it to authorized members for
// client-side E2E — that is the design, not a leak). What must NEVER appear is
// a NEAR PRIVATE key; that lives only on the gated Shade API. The guard below
// greps the emitted spec for "private_key" and fails the build if present.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { contract } from '../src/contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'openapi.json');

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const spec = await generator.generate(contract, {
  info: {
    title: 'NOVA Public API',
    version: '0.4.0',
    description:
      'Verifiable, privacy-preserving shared storage. Public wire protocol ' +
      '(MCP /tools/*). Authenticate with a nova_session bearer token from ' +
      'nova-sdk.com. Every success response is wrapped in { "result": ... }.',
  },
  servers: [
    {
      url: 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network',
      description: 'Production MCP (v19)',
    },
  ],
  security: [{ novaSession: [] }],
  components: {
    securitySchemes: {
      novaSession: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'nova_session token from nova-sdk.com/api/auth/session-token',
      },
    },
  },
});

const json = JSON.stringify(spec, null, 2);

// ── build-time guard ──────────────────────────────────────────────────────────
if (json.toLowerCase().includes('private_key')) {
  console.error('✗ SECURITY: emitted spec contains "private_key". Refusing to write.');
  process.exit(1);
}

const pathCount = Object.keys(
  (spec as { paths?: Record<string, unknown> }).paths ?? {},
).length;
if (pathCount === 0) {
  console.error('✗ spec has 0 paths — the contract produced nothing. Aborting.');
  process.exit(1);
}

writeFileSync(OUT, json + '\n');
console.log(`✓ Wrote ${OUT}`);
console.log(`✓ ${pathCount} paths, no private_key material.`);
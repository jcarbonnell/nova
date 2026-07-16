// shade-agent/src/routes/key-management.ts - manages keys for NOVA groups in shade agent
//
// THIN HTTP ADAPTER. All logic lives in lib/services/key-management.ts.
//  This file owns only: 
// - the X-Internal-Auth gate, 
// - master-seed init, 
// - Zod validation, 
// - mapping service results / ApiError to responses.
//
// MIDDLEWARE ORDER IS LOAD-BEARING: gate → seed → Zod → handler.
// The gate is transport auth and stays OUTERMOST.
import { Hono } from 'hono';
import { initializeMasterSeed } from '../lib/seed.js';
import { checkInternalAuth } from '../lib/auth.js';
import { getAttestation } from '../lib/attestation.js';
import { DEFAULT_MAINNET_CONTRACT } from '../lib/near.js';
import { errorHandler } from '../lib/errors.js';
import { validate, body, GenerateKeySchema, GetKeySchema, RotateKeySchema, } from '../lib/schemas.js';
import { generateGroupKey, getGroupKey, rotateGroupKey, } from '../lib/services/key-management.js';
const keyMgmt = new Hono();
keyMgmt.onError(errorHandler);
// Internal gate (v0.3.2 Fix 3). Health is exempt.
keyMgmt.use('*', async (c, next) => {
    const p = c.req.path;
    if (c.req.method === 'GET' && (p === '/api/key-management/health' || p === '/api/key-management/health/')) {
        return next();
    }
    if (!checkInternalAuth(c.req.header('x-internal-auth'))) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
});
// Env validation (once) + master seed (idempotent).
let envValidated = false;
keyMgmt.use('*', async (c, next) => {
    if (!envValidated) {
        const SHADE_AGENT_ACCOUNT_ID = process.env.SHADE_AGENT_ACCOUNT_ID;
        const TEE_SECRET = process.env.TEE_KEY_SECRET || '';
        if (!SHADE_AGENT_ACCOUNT_ID)
            throw new Error('SHADE_AGENT_ACCOUNT_ID required');
        if (!/^[0-9a-f]{64}$/i.test(TEE_SECRET)) {
            throw new Error('TEE_KEY_SECRET must be a 64-char hex string (32 bytes)');
        }
        envValidated = true;
    }
    await initializeMasterSeed();
    await next();
});
// ────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────
keyMgmt.get('/health', async (c) => {
    const attestation = await getAttestation();
    return c.json({
        status: 'ok',
        contract: DEFAULT_MAINNET_CONTRACT,
        network: 'mainnet',
        timestamp: new Date().toISOString(),
        master_seed_status: 'initialized',
        attestation: attestation.provider,
        attestation_pcr0: attestation.pcr0,
        attestation_verified: attestation.verified,
    });
});
keyMgmt.post('/generate_key', validate(GenerateKeySchema), async (c) => c.json(await generateGroupKey(body(c, GenerateKeySchema))));
keyMgmt.post('/get_key', validate(GetKeySchema), async (c) => c.json(await getGroupKey(body(c, GetKeySchema))));
keyMgmt.post('/rotate_key', validate(RotateKeySchema), async (c) => c.json(await rotateGroupKey(body(c, RotateKeySchema))));
export default keyMgmt;

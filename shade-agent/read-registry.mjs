// read-registry.mjs — READ-ONLY check of the production retention registry.
// RETENTION_REGISTRY_KEY is unset here, so listRetentionGroups() reads the
// production 'retention-registry' singleton. No writes.
import { initializeMasterSeed } from './dist/lib/seed.js';
await initializeMasterSeed();
const svc = await import('./dist/lib/services/retention.js');
const list = await svc.listRetentionGroups();
console.log('retention registry:', JSON.stringify(list));
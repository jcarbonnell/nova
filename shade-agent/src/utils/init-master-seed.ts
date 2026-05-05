import { getBlobFromKV } from './kv-contract';
import { setMasterSeed, initializeEnclaveSigner, decryptBlob } from './derivation';

/**
 * Initialize master seed from KV contract
 * Call this on app startup
 */
export async function initializeMasterSeed(): Promise<void> {
  console.log('🔐 Loading master seed from KV contract...');
  
  const encryptedBlob = await getBlobFromKV('master-root');
  
  if (!encryptedBlob) {
    throw new Error(
      'CRITICAL: Master seed not found in KV contract (nova-kv.near)\n' +
      'Key "master-root" must exist with encrypted master seed.'
    );
  }

  const masterSeed = decryptBlob(encryptedBlob);
  setMasterSeed(masterSeed);
  
  await initializeEnclaveSigner();
  
  console.log('✅ Master seed initialization complete\n');
}
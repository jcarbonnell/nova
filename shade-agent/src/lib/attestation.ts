// shade-agent/src/lib/attestation.ts
//
// Lifted verbatim from the identical copies in routes/user-keys.ts and
// routes/key-management.ts. (Step 4 carry: this was the last duplicated helper
// alongside checkInternalAuth.)
//
// TODO: replace stub with real Nitro enclave attestation once deployed.
// Production path:
//   1. Read PCR0/PCR1/PCR2 from /dev/nsm via vsock or NSM API
//   2. Fetch expected hashes stored in KV contract under key 'expected-pcrs'
//   3. Compare and throw if mismatch — block all key ops until attestation passes
//
// Roadmap: the real attestation chain lands in v0.4 Step 9.

export async function getAttestation(): Promise<{ provider: string; pcr0: string; verified: boolean }> {
  const provider = process.env.ENCLAVE_PROVIDER || 'local';

  if (provider === 'nitro') {
    // Real Nitro path (uncomment when NSM device is available):
    // const nsm = await import('@aws-nitro-enclaves/nsm-api');
    // const doc = await nsm.getAttestationDoc();
    // const pcr0 = doc.pcrs[0].toString('hex');
    // const expected = await getBlobFromKV('expected-pcrs');
    // if (!expected || !verifyPcrs(doc.pcrs, expected)) throw new Error('Attestation mismatch');
    // return { provider: 'nitro', pcr0, verified: true };
    throw new Error('Nitro NSM not yet wired — set ENCLAVE_PROVIDER=local for dev');
  }

  // Stub for local / pre-Nitro development
  const devPcr0 = process.env.DEV_PCR0 || '0'.repeat(96); // 48-byte PCR0 as hex
  return { provider: 'local', pcr0: devPcr0, verified: false };
}
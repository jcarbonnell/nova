# TEE Attestation (Phase 2 / Stretch Goal)

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 (contract + crypto) and #001-02 (key hierarchy), to integrate with the NEAR agent-contract and KV contract for TEE attestation verification. When deployed on Phala CVM, the API can cryptographically prove it is running untampered code inside a genuine hardware enclave (AWS Nitro). This protects the master seed with hardware-level encryption (TEE_KEY_SECRET) rather than a software secret.

### Overview
Integrate the NOVA API with the NEAR contracts for TEE attestation. Register as a trusted worker via `approve_shade_code_hash` + `register_shade_worker`. Store encrypted keys in the KV contract (`store`) which gates writes by TEE code hash. Expose attestation status via an endpoint. When running on Phala: full TEE security. When running locally: fall back to software secrets.

### Acceptance Criteria

**Agent-Contract Integration (shade-agent contract):**
- [ ] `approve_shade_code_hash`: Contract owner approves the NOVA API's code hash — prerequisite for worker registration
- [ ] `register_shade_worker`: Register the NOVA API as a TEE worker, submitting a DstackAttestation to prove enclave authenticity
- [ ] Crypto: derive agent account from sponsor key, compute attestation from Nitro enclave measurements
- [ ] Auto-re-registration before validity window expires (typically 6 days)
- [ ] Non-blocking startup: server starts immediately, registration runs in background
- [ ] Local mode fallback: when not on Phala, use the contract's existing local/whitelist support

**KV Contract Integration:**
- [ ] `kv.add_code_hash(code_hash)`: Contract owner authorizes the NOVA API's TEE code hash for write access
- [ ] `kv.store(key, encrypted_blob)`: Store encrypted keys in NEAR KV — write access gated by code hash
- [ ] `kv.get(key)`: Retrieve encrypted blobs (public read, safe because blobs are TEE-encrypted)
- [ ] This replaces PostgreSQL for storing encrypted key material — keys live on-chain, encrypted, TEE-gated

**Attestation Service (`api/src/services/attestation.ts`):**
- [ ] `getAttestation(): Promise<{ provider, pcr0, verified, measurements }>` — real attestation data from Phala CVM
- [ ] Integration with Phala SDK for attestation generation
- [ ] Return `verified: true` with valid PCR0, RTMR measurements, and PPID
- [ ] No stub — real data when on Phala, graceful degradation when local

**Master Seed Protection:**
- [ ] When TEE is available: encrypt master seed with TEE_KEY_SECRET (hardware-derived) before storing in KV
- [ ] When TEE is NOT available: fall back to BETTER_AUTH_SECRET (software secret) — already implemented in #001-01
- [ ] `loadMasterSeed()` auto-detects TEE availability vs fallback

**Attestation Endpoint:**
- [ ] `GET /api/nova/attestation` returns: `{ provider, pcr0, rtmm0, rtmm1, rtmm2, ppid, verified, validUntil }`
- [ ] Clients can independently verify against the agent-contract's approved measurements
- [ ] Cache attestation data (valid until expiry)

### Notes
- [ ] The agent-contract already supports local mode (`whitelisted_agents_for_local`) — no contract changes needed
- [ ] The KV contract gates writes by TEE code hash (`allowed_code_hashes`) — owner adds NOVA's hash on deploy
- [ ] Both contracts are already deployed and working — no new contracts needed
- [ ] TEE attestation is valuable for production deployments where users need to verify the API is untampered
- [ ] For development and MVP, skip this ticket — use software-only master seed protection
- [ ] The original shade-agent has reference implementations of attestation and agent registration
- [ ] Attestation expiry is typically 6 days — auto-re-registration must happen before expiry

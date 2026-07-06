# TEE Attestation (Phase 2 / Stretch Goal)

### Context
This is a child ticket of #001-rebuild-nova, depends on #001-01 (contract + crypto) and #001-02 (key hierarchy), to integrate with the NEAR agent-contract for TEE attestation verification. Not required for MVP — the existing agent-contract already supports local/whitelist mode without TEE. This ticket enables deployment on Phala CVM with hardware-level security guarantees.

### Overview
Integrate the NOVA API with the NEAR agent-contract to produce verifiable TEE attestations. When deployed on Phala CVM, the API can cryptographically prove it is running untampered code inside a genuine hardware enclave (AWS Nitro). This protects the master seed with hardware-level encryption (TEE_KEY_SECRET) rather than a software secret, and allows users/contracts to verify the API's integrity via attested PCR measurements.

### Acceptance Criteria

**Attestation Service (`api/src/services/attestation.ts`):**
- [ ] `getAttestation(): Promise<{ provider, pcr0, verified, measurements }>` — return real attestation data from the Phala CVM enclave
- [ ] `verifyAttestation(): Promise<boolean>` — verify the attestation against the agent-contract's approved measurements
- [ ] Integration with `@neardefi/shade-agent-js` or equivalent for attestation generation
- [ ] Return `verified: true` with valid PCR0, RTMR measurements, and PPID
- [ ] Expose through a `GET /api/nova/attestation` endpoint
- [ ] No hardcoded stub (`verified: false`) — use real attestation data when running on Phala, degrade gracefully on local

**Master Seed Protection:**
- [ ] When TEE is available: encrypt master seed with TEE_KEY_SECRET (hardware-derived key) before storing in PostgreSQL
- [ ] When TEE is NOT available: fall back to BETTER_AUTH_SECRET (software secret) — implemented in ticket #001-01
- [ ] Master seed decryption auto-detects TEE availability vs fallback

**Agent-Contract Integration:**
- [ ] Register the NOVA API as an agent with the NEAR agent-contract
- [ ] Submit DstackAttestation on registration to prove enclave authenticity
- [ ] Auto-re-registration before validity window expires
- [ ] Non-blocking registration at startup (server starts immediately, registration runs in background)
- [ ] Handle the contract's local/whitelist mode for development without TEE

**Verification Endpoint:**
- [ ] `GET /api/nova/attestation` returns:
  - `{ provider, pcr0, rtmm0, rtmm1, rtmm2, ppid, verified, valid_until, measurements }`
- [ ] Clients can independently verify these values against the agent-contract's approved lists
- [ ] Cache attestation data (valid until expiry, typically 6 days)

**Deployment:**
- [ ] Dockerfile or configuration for Phala CVM deployment
- [ ] Environment variables: `TEE_ENABLED`, `TEE_KEY_SECRET`, `AGENT_CONTRACT_ID`, `SPONSOR_ACCOUNT_ID`, `SPONSOR_PRIVATE_KEY`
- [ ] Graceful fallback when not running on Phala (use local mode)

### Notes
- [ ] The agent-contract already supports local mode (`whitelisted_agents_for_local`) — no smart contract changes needed
- [ ] TEE attestation is valuable for production deployments where users need to verify the API is untampered
- [ ] For development and MVP, skip this ticket entirely — use software-only master seed protection
- [ ] The original shade-agent has reference implementations of attestation and agent registration in `src/routes/user-keys.ts` and `src/index.ts`
- [ ] Attestation expiry is typically 6 days — auto-re-registration must happen before expiry
- [ ] Circuit breaker from ticket #001-06 should cover agent-contract RPC calls as well

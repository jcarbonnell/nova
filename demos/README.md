# NOVA + Phala TEE Demo: Verifiable Federated Learning Datasets

## Use Case
In healthcare (e.g., Phala's success story: https://phala.com/success-stories/healthcare-research), hospitals share encrypted records for federated learning without exposure. Phala's TEEs ensure confidential training, but lack persistent storage—NOVA complements by providing secure vaults for datasets pre/post-TEE, with group revocation for compliance (e.g., GDPR). This enables verifiable, multi-party workflows: upload shared data, TEE fine-tunes, store models back—auditable via on-chain metadata.

### Other Scenarios
- **Finance: Secure Portfolio Sharing Before TEE Risk Analysis** (https://phala.com/success-stories/financial-services): NOVA's group-keyed vaults store encrypted portfolios; TEE loads for private risk modeling (e.g., fraud detection), outputs back without leaks—ensures data sovereignty in multi-bank collaborations.
- **Law: Confidential Document Vaults Before TEE Review** (https://phala.com/posts/confidential-ai-for-law-firms): Upload sensitive legal docs to NOVA; TEE processes (e.g., AI contract analysis) without visibility; revoke access post-review—complements Phala's privacy for e-discovery.
- **Decentralized AI: Persistent Agent State for Multi-Chain Agents** (https://phala.com/success-stories/decentralized-ai): NOVA persists encrypted agent states/models between TEE sessions; enables multi-chain autonomy (e.g., cross-NEAR/Solana inference) with attestation chaining.


## How NOVA Complements Private ML SDK
Phala focuses on runtime privacy ("no storage, no logs"); NOVA adds decentralized persistence: encrypt/upload via composite_upload, retrieve into TEE, output back. Focus: Data pipeline security without reinventing Phala's compute. NOVA handles pre-enclave sourcing (group auth) and post-enclave auditing (on-chain hashes/CIDs), extending Phala's quotes for full-lifecycle verifiability.

## Running the Demos
- Set .env (NEAR_PRIVATE_KEY, etc.).
- Rust: `cargo run --bin tee_federated_learning`.
- JS: `ts-node demos/tee_federated_learning.ts`.
- Python: `python demos/tee_federated_learning.py`.
Expect: Uploaded CID, mock-processed output CID.
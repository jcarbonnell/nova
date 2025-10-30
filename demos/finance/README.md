# NOVA for Finance: : Secure Portfolio Sharing Before TEE Risk Analysis

NOVA's group-keyed vaults store encrypted portfolios; TEE loads for private risk modeling (e.g., fraud detection), outputs back without leaks—ensures data sovereignty in multi-bank collaborations. 

## Use Case
In Finance (e.g., Phala's success story: (https://phala.com/success-stories/financial-services))

## How NOVA Complements Private ML SDK
Phala focuses on runtime privacy ("no storage, no logs"); NOVA adds decentralized persistence: encrypt/upload via composite_upload, retrieve into TEE, output back. Focus: Data pipeline security without reinventing Phala's compute. NOVA handles pre-enclave sourcing (group auth) and post-enclave auditing (on-chain hashes/CIDs), extending Phala's quotes for full-lifecycle verifiability.

## Running the Demos
- Set .env (NEAR_PRIVATE_KEY, etc.).
- Rust: `cargo run --bin tee_federated_learning`.
- JS: `ts-node demos/tee_federated_learning.ts`.

Expected output:
```
Primary Account ID (Hospital A): <hospital_A.testnet>
Secondary Account ID (Hospital B): <hospital_B.testnet>
Hospital A uploaded to NOVA: CID QmW9oCqbrdMF8cKuYd14cwT3SszMWXRnaJ4aTZXKG4b1QA
Waiting for IPFS pin to propagate...
Hospital B output stored: CID QmSxuYEMhJpCm2wxC9zRQrbvaJN2irGtNdENCxRzs6J39C
Waiting for IPFS pin to propagate...
Hospital A final output stored: CID QmP5TiZYHByf1DDtXxVe5KjHj8r5Sp2E2MzLCMAxfH3Job
```
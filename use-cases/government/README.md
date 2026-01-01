# NOVA for Governments: Electronic ID Document Vaults

Citizens securely upload their national ID document **once** to a personal, decentralized vault powered by NOVA. They retain full sovereignty, granting temporary access to public servants or government services as needed, and revoking it afterward, ensuring privacy, self-sovereignty, and revocable consent without centralized entity.

## Use Case
In a national electronic ID (eID) system, citizens upload a scanned or digitally issued national ID document **once** to their personal NOVA group (e.g., `myID`). The document is encrypted client-side and stored on IPFS, with metadata logged immutably on the NEAR blockchain.

When accessing a public service (e.g., tax filing, benefits application, or permit request):
- The citizen temporarily adds the public servant aas an authorized member to their personal group.
- The servant retrieves a TEE-secured group key via nonce-based authentication, decrypts the ID locally, verifies it, and provides the service.
- After completion, the citizen revokes access by removing the servant from the group, triggering automatic key rotation in Trusted Execution Environments (TEEs)—rendering any prior keys useless without re-encrypting or re-uploading the document.

This enables secure, privacy-preserving digital identification for government services while complying with principles like GDPR data minimization and user control. No permanent access is granted, and all actions are auditable on-chain.


## How NOVA matches the needs of government administration
- **User Sovereignty & Privacy**: Citizens control their own personal groups—no central authority holds keys or plaintext data. Encryption is end-to-end, with keys managed securely in TEEs (Shade Agents).
- **One-Time Upload**: ID documents are uploaded and encrypted once; access is managed dynamically via group membership changes.
- **Revocable, Temporary Access**: Add/remove members instantly; key rotation on revocation ensures forward secrecy without expensive re-encryption.
- **Verifiable Integrity**: File hashes and access logs are stored on NEAR for tamper-proof auditing and compliance.
- **Scalability & Low Cost**: NEAR's sharded blockchain handles millions of personal groups efficiently at minimal transaction fees.
- **Decentralized & Resilient**: No single point of failure—combines IPFS storage with blockchain logging and TEE key distribution.
- **Extensible for Selective Disclosure**: Future enhancements can split ID attributes into separate encrypted files for zero-knowledge proofs (e.g., prove age > 18 without revealing full ID).
- **Integration Ready**: Works with NEAR wallets for seamless citizen/servant authentication; suitable for web/mobile eID apps.

This approach transforms traditional centralized eID systems into a self-sovereign model, reducing risks of data breaches while streamlining public service delivery.

## Running the Demos
- Set .env file
- Rust: `cargo run --bin eID-demo.rs`.
- JS: `ts-node eID-demo.ts`.

Expected output:
```
Successful group creation, one-time encrypted upload, temporary access grant/verification, and clean revocation with key invalidation.
```
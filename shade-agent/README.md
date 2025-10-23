# NOVA Shade Agent: TEE-Secured Key Manager

> [!WARNING]  
> This technology has not yet undergone a formal audit. Please conduct your own due diligence and exercise caution before integrating or relying on it in production environments.

This is a Shade Agent template customized for NOVA v2.2, implementing TEE-secured group key management for secure file-sharing on NEAR. The agent generates, stores (encrypted in SQLite), rotates, and distributes symmetric keys (AES-CBC, 32-byte base64) exclusively off-chain within Trusted Execution Environments (TEEs). It verifies ephemeral access tokens (ed25519-signed, nonce/timestamp-gated) from the NOVA contract, ensuring no keys are ever exposed on-chain.

This setup hybridizes NOVA with Shade Agents for bullet-proof privacy: On-chain handles auditable groups/metadata; TEEs manage keys with attestations (checksums/code hashes) for verifiability. Multi-instance workers (identical code hashes) enable shared access without single points of failure.

For full instructions on the Shade Agent Framework, please refer to this [docs](https://docs.near.org/ai/shade-agents/getting-started/introduction). For NOVA-specific information, see [NOVA Docs](https://nova-25.gitbook.io/nova-docs).

## Prerequisites

- First, `clone` this NOVA Shade Agent repo.

```bash
git clone https://github.com/jcarbonnell/nova.git  # Or your fork
cd nova/shade-agent
```

- Install NEAR and Shade Agent tooling:

```bash
# Install the NEAR CLI
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh

# Install the Shade Agent CLI
npm i -g @neardefi/shade-agent-cli
```

- Create a `NEAR testnet account` and record the account name and `seed phrase`:

```bash
near account create-account sponsor-by-faucet-service <example-name.testnet> autogenerate-new-keypair print-to-terminal network-config testnet create
```

replacing <example-name.testnet> with a unique name.

- Set up docker if you have not already:

Install Docker for [Mac](https://docs.docker.com/desktop/setup/install/mac-install/) or [Linux](https://docs.docker.com/desktop/setup/install/linux/) and set up an account.

Log in to docker, `docker login` for Mac or `sudo docker login` for Linux.

- Set up a free Phala Cloud account at https://cloud.phala.network/register then get an API key from https://cloud.phala.network/dashboard/tokens.

What is a Phala Cloud?

Phala Cloud is a service that offers secure and private hosting in a TEE using [Dstack](https://docs.phala.network/overview/phala-network/dstack). Phala Cloud makes it easy to run a TEE, that's why we use it in our template!

---

## Set up

- Rename the `.env.development.local.example` file name to `.env.development.local` and configure your environment variables.

- Start up Docker:

For Mac

Simply open the Docker Desktop application or run:

```bash
open -a Docker
```

For Linux

```bash
sudo systemctl start docker
```

- Install dependencies 

```bash
npm i
```

---

## Local development

- Make sure the `NEXT_PUBLIC_contractId` prefix is set to `ac-proxy.` followed by your NEAR accountId.

- In one terminal, run the Shade Agent CLI:

```bash
shade-agent-cli
```

The CLI on Linux may prompt you to enter your `sudo password`.

- In another terminal, start your app:

```bash
npm run dev
```

Your app will start on http://localhost:3000

---

## TEE Deployment

- Change the `NEXT_PUBLIC_contractId` prefix to `ac-sandbox.` followed by your NEAR accountId.

- Run the Shade Agent CLI

```bash
shade-agent-cli
```

The CLI on Linux may prompt for your sudo password. It builds, pushes Docker image, and deploys to Phala Cloud. The final URL (e.g., https://<hash>-3000.dstack-prod5.phala.network) hosts your agent.

Monitor deployment/logs in the Phala Dashboard. Update APP_CODEHASH in .env if needed (CLI auto-generates).

**Post-Deployment**:
- Approve code hash on NOVA contract: near call nova-sdk-4.testnet approve_shade_code_hash '{"code_hash": "your-app-code-hash"}' --accountId nova-sdk-4.testnet.
- Register worker: near call nova-sdk-4.testnet register_shade_worker '{"worker_id": "your-shade-account.testnet", "attestation": "base64-attestation-from-cli"}' --accountId nova-sdk-4.testnet.

---

## Interacting with the Agent

Interact via APIs (Hono routes) or the lightweight frontend for testing. For Phala deployments, use your deployment URL as base (e.g., https://<hash>-3000.dstack-prod5.phala.network).

## Direct API Calls

All routes under /api/key-management; require JSON POST with auth (e.g., from NOVA events/tokens).

- Generate Key (Triggered post-group creation):
```bash
POST http://localhost:3000/api/key-management/generate_key
Body: {"group_id": "test_group", "owner": "nova-sdk-4.testnet"}
```
Response: {"key": "base64-random-key", "checksum": "hex-tee-attestation"} (Update checksum on NOVA via update_checksum).
- Get Key (For authorized users with token):
```bash
POST http://localhost:3000/api/key-management/get_key
Body: {"group_id": "test_group", "token": "payload_b64.signature_hex"}
```
Response: {"key": "base64-group-key", "checksum": "hex-tee-attestation"} (Ephemeral; verify checksum on-chain).

- Rotate Key (Triggered post-revocation):
```bash
POST http://localhost:3000/api/key-management/rotate_key
Body: {"group_id": "test_group"}
```
Response: {"success": true, "new_key_hash": "sha256-hex", "checksum": "hex-tee-attestation"}.

---

## Security & Verification

- **TEE Isolation**: Keys encrypted in SQLite with TEE-derived secret (AES-256-CBC); inaccessible outside enclave.
- **Token Verification**: ed25519 sig on SHA256(payload) + nonce (contract-checked) + timestamp (5min window) + RPC pubkey fetch.
- **Attestation**: Every response includes checksum from agentInfo()—verify via NOVA get_group_checksum.
- **Multi-Instance**: Deploy multiple workers with same code hash for redundancy; shared DB access via TEE.
- **Auditing**: Logs events; monitor Phala Dashboard. Prod: Use mainnet RPC, formal audits.

For NOVA integration: Trigger routes via off-chain indexers (e.g., on EVENT_JSON: logs) or MCP server.

## Troubleshooting

- **CLI Errors**: Ensure Docker running, Phala API key valid. Check shade-agent-cli --help.
- **Attestation Fails**: Verify code hash approved on NOVA; re-run CLI for fresh build.
- **Key Mismatch**: Ensure TEE_SECRET consistent across deploys; test token claim first.
- **Phala Logs**: Dashboard > Apps > Your App > Logs.

## Contributing

Contributions are welcome! We accept contributions for:
- Bug fixes and improvements
- New SDK features
- Documentation enhancements
- Integration examples
- Test coverage

## Resources

- [NOVA Docs](https://nova-25.gitbook.io/nova-docs/)
- [NEAR Docs](https://docs.near.org)
- [Shade Agents Docs](https://docs.near.org/ai/shade-agents/)
- [Phala Docs](https://docs.phala.com/)

## License

MIT License - see LICENSE for details.

---

**Secure your keys in TEEs—build with NOVA today!** Questions? GitHub Issues.

---
name: nova
version: 1.0.0
description: >
  Securely store and retrieve encrypted files from NOVA groups using the NEAR protocol.
  Use for accountancy records, client data, and any file that needs immutable encrypted
  storage with group-based access control. Powered by NOVA v2.1 on Phala TEE.
requires:
  bins:
    - bash
    - curl
    - jq
    - python3
  env:
    - NOVA_API_KEY
    - NOVA_MCP_URL
    - NOVA_ACCOUNT_ID
---

# NOVA Skill

## Account
This agent uses `near-launchpad-api.nova-sdk.near` as its NOVA identity.
All scripts read credentials from environment variables — never hardcode them.

---

## 1. Check authorization for a group

```bash
/opt/ironclaw/.ironclaw/skills/nova/check_auth.sh GROUP_ID
```

---

## 2. Upload a file to a NOVA group

```bash
/opt/ironclaw/.ironclaw/skills/nova/upload_to_nova.sh GROUP_ID /path/to/file.json
```

Returns the IPFS CID of the encrypted file. Store this CID — it is the permanent reference.

---

## 3. Retrieve and decrypt a file from a NOVA group

```bash
/opt/ironclaw/.ironclaw/skills/nova/retrieve_and_decrypt.sh GROUP_ID IPFS_CID
```

Outputs decrypted file contents to stdout.

---

## 4. Register a new NOVA group (owner only, costs 0.65 NEAR)

```bash
/opt/ironclaw/.ironclaw/skills/nova/register_group.sh GROUP_ID
```

---

## 5. Add a member to a group (owner only, costs 0.01 NEAR)

```bash
/opt/ironclaw/.ironclaw/skills/nova/add_member.sh GROUP_ID MEMBER_ACCOUNT_ID
```

---

## Accountancy workflow

When a campaign payment is confirmed:
1. Build invoice JSON at `/tmp/invoice-CAMPAIGN_ID.json`
2. Run `upload_to_nova.sh launchpad-accountancy /tmp/invoice-CAMPAIGN_ID.json`
3. Store the returned CID in the `invoices` PostgreSQL table

To audit all invoices ever uploaded:
```bash
/opt/ironclaw/.ironclaw/skills/nova/list_group_transactions.sh launchpad-accountancy
```

---

## DO NOT
- Run raw curl commands against the MCP server directly
- Hardcode NOVA_API_KEY, NOVA_MCP_URL, or NOVA_ACCOUNT_ID in any message
- Share IPFS CIDs publicly — they reference encrypted files but CID exposure is unnecessary
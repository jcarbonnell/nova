---
name: nova-skill
description: Securely retrieve encrypted files from NOVA groups. Users grant access to their groups, and the agent retrieves files confidentially within TEE.
---

# NOVA File Sharing Skill

### Retrieve and Decrypt File

**ALWAYS use this script to retrieve and decrypt files:**
```bash
~/openclaw/skills/nova-file-sharing/retrieve_and_decrypt.sh GROUP_ID IPFS_CID
```

Example:
```bash
~/openclaw/skills/nova-file-sharing/retrieve_and_decrypt.sh demo_campaign QmZBtuiHonPxguYFysU54N5CPHsReDDEfqYCX5ekih8Vby
```

**DO NOT** try to run curl commands or Python scripts separately. The shell script handles everything: authentication, retrieval, and decryption.

## How to Check Authorization
```bash
~/openclaw/skills/nova-file-sharing/check_auth.sh GROUP_ID
```

## Required User Information

To retrieve files, user must provide:
1. **Group ID** - NOVA group name (e.g., `demo_campaign`)
2. **IPFS CID** - File hash starting with `Qm` or `bafy`

## Workflow for Email Campaigns

Users upload two files to their NOVA group:
1. `contacts.csv` - Contact list with email, full_name, and optional fields
2. `payment_key.txt` - Their NEAR Email payment key

Then grant access to `nova-bizdev.nova-sdk.near` and provide:
- Group ID
- IPFS CID for both files
- Campaign instructions

## User Instructions

1. **Create a NOVA account** at https://nova-sdk.com
2. **Create a group** for your campaign data
3. **Upload your files** (contacts.csv, payment_key.txt)
4. **Grant access:** `nova group add-member GROUP_ID nova-bizdev.nova-sdk.near`
5. **Provide IPFS CID** to the agent
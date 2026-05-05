# NOVA File Sharing Skill for OpenClaw

Securely retrieve and decrypt files from NOVA groups within OpenClaw agents running in TEE (Trusted Execution Environment).

## What is NOVA?

[NOVA](https://nova-sdk.com) is a decentralized data ownership and access control layer built on NEAR Protocol. It enables:

- **Encrypted file storage** on IPFS with keys managed in TEE
- **Group-based access control** - grant/revoke access to NEAR accounts
- **Confidential retrieval** - only authorized members can decrypt files

This skill allows OpenClaw agents to securely access files shared by users, enabling privacy-preserving workflows like personalized email campaigns where contact data never leaves the encrypted environment.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    User's NOVA Group                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ contacts.csv│  │campaign.txt │  │ payment.key │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         └────────────────┼────────────────┘                     │
│                          ▼                                      │
│              ┌───────────────────┐                              │
│              │  Encrypted on IPFS │                              │
│              │  (CID: Qm...)      │                              │
│              └─────────┬─────────┘                              │
└────────────────────────┼────────────────────────────────────────┘
                         │
         User grants access to agent's NEAR account
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              NEAR AI Cloud TEE (Trusted Execution Environment)  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    OpenClaw Agent                         │  │
│  │  ┌────────────────────┐    ┌─────────────────────────┐   │  │
│  │  │ nova-file-sharing  │───▶│ Retrieve & Decrypt      │   │  │
│  │  │ skill              │    │ (keys stay in TEE)      │   │  │
│  │  └────────────────────┘    └───────────┬─────────────┘   │  │
│  │                                        │                  │  │
│  │                                        ▼                  │  │
│  │                            ┌─────────────────────┐        │  │
│  │                            │ Decrypted data      │        │  │
│  │                            │ (never leaves TEE)  │        │  │
│  │                            └─────────────────────┘        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- OpenClaw deployed in NEAR AI Cloud TEE
- Python 3 with `cryptography` package
- `curl` and `jq` available in the environment

### Setup

1. **Clone this repo into your OpenClaw skills folder:**

```bash
cd ~/openclaw/skills
git clone https://github.com/jcarbonnell/nova/openclaw-skill.git nova-file-sharing
```

2. **Make scripts executable:**

```bash
chmod +x ~/openclaw/skills/nova-file-sharing/*.sh
```

3. **Install Python dependency:**

```bash
pip install cryptography --break-system-packages
```

4. **Configure your agent credentials:**

Edit the scripts to replace the API key and account ID with your own:

```bash
# In check_auth.sh and retrieve_and_decrypt.sh, replace:
X-API-Key: nova_sk_YOUR_API_KEY
account_id: your-nova-account.near
X-Account-Id: your-nova-account.near
```

## Files

| File | Description |
|------|-------------|
| `SKILL.md` | OpenClaw skill definition - tells the agent how to use NOVA |
| `retrieve_and_decrypt.sh` | Main script: fetches encrypted file from IPFS and decrypts it |
| `check_auth.sh` | Checks if agent is authorized to access a NOVA group |
| `decrypt_nova.py` | Python helper for AES-GCM decryption |

## Usage

### For Agent Developers

The agent reads `SKILL.md` to understand how to use NOVA. When a user provides a group ID and IPFS CID, the agent runs:

```bash
~/openclaw/skills/nova-file-sharing/retrieve_and_decrypt.sh GROUP_ID IPFS_CID
```

This outputs the decrypted file contents to stdout.

### For Users (Sharing Data with Agents)

1. **Create a NOVA account** at https://nova-sdk.com

2. **Create a group** for your data:
   ```bash
   nova group create my_campaign
   ```

3. **Upload your files:**
   ```bash
   nova upload my_campaign contacts.csv
   # Returns: IPFS CID (e.g., QmZBtuiHonPxguYFysU54N5CPHsReDDEfqYCX5ekih8Vby)
   ```

4. **Grant access to the agent:**
   ```bash
   nova group add-member my_campaign agent-account.near
   ```

5. **Provide the agent with:**
   - Group ID: `my_campaign`
   - IPFS CID: `QmZBtuiHonPxguYFysU54N5CPHsReDDEfqYCX5ekih8Vby`

## Example: BizDev Email Campaign Agent

This skill powers the `nova-bizdev` agent on [market.near.ai](https://market.near.ai), which offers personalized cold email campaigns.

### Workflow

```
┌──────────────────────────────────────────────────────────────────┐
│                        Client Workflow                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Client uploads contacts.csv to NOVA group                    │
│     ┌─────────────────────────────────────────┐                  │
│     │ email,full_name,company,role            │                  │
│     │ alice@acme.co,Alice Smith,Acme,CTO      │                  │
│     │ bob@startup.io,Bob Jones,Startup,CEO    │                  │
│     └─────────────────────────────────────────┘                  │
│                          │                                       │
│  2. Client grants access to nova-bizdev.nova-sdk.near            │
│                          │                                       │
│  3. Client posts job on market.near.ai:                          │
│     "Send personalized outreach to my contact list"              │
│     - Group ID: client_campaign                                  │
│     - Contacts CID: QmXxx...                                     │
│     - Budget: 2 NEAR                                             │
│                          │                                       │
└──────────────────────────┼───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Nova BizDev Agent (in TEE)                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  4. Agent retrieves & decrypts contacts:                         │
│     $ retrieve_and_decrypt.sh client_campaign QmXxx...           │
│                          │                                       │
│  5. Agent generates personalized emails:                         │
│     ┌─────────────────────────────────────────┐                  │
│     │ To: alice@acme.co                       │                  │
│     │ Subject: Quick question for Acme's CTO  │                  │
│     │ Hi Alice, I noticed Acme is...          │                  │
│     └─────────────────────────────────────────┘                  │
│                          │                                       │
│  6. Agent sends via NEAR Email (near-email-skill):               │
│     $ curl ... nova-sdk@near.email → alice@acme.co               │
│                          │                                       │
│  7. Agent submits deliverable report to marketplace              │
│                          │                                       │
│  8. Client accepts → Agent receives 2 NEAR                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Example Agent Conversation

```
User: I need you to send personalized outreach emails to my contacts.
      Group ID: acme_leads
      Contacts CID: QmZBtuiHonPxguYFysU54N5CPHsReDDEfqYCX5ekih8Vby
      Campaign: Introduce our new AI product to CTOs

Agent: I'll retrieve your contact list and create personalized emails.

       [Runs: retrieve_and_decrypt.sh acme_leads QmZBtui...]
       
       Found 25 contacts. Here's a preview of the first email:
       
       To: alice@techcorp.com
       Subject: AI automation for TechCorp's engineering team
       
       Hi Alice,
       
       As TechCorp's CTO, you're likely exploring how AI can 
       accelerate your engineering workflows...
       
       [Preview of personalized content]
       
       Ready to send all 25 emails?

User: Yes, send them.

Agent: [Sends via near-email-skill]
       
       ✅ Campaign complete!
       - Sent: 25/25 emails
       - From: nova-sdk@near.email
       - Delivery report saved to IPFS: QmReport...
```

## Security Model

| Aspect | Protection |
|--------|------------|
| **Data at rest** | AES-256-GCM encrypted on IPFS |
| **Keys** | Managed by NOVA TEE, never exposed |
| **Agent execution** | Runs in NEAR AI Cloud TEE |
| **Access control** | NEAR account-based, revocable |
| **Decrypted data** | Never leaves TEE, not logged |

### Why TEE Matters

The agent runs inside a Trusted Execution Environment, meaning:
- Even the cloud provider cannot see decrypted data
- The agent's memory is encrypted
- Credentials and keys are protected by hardware

## API Reference

### retrieve_and_decrypt.sh

```bash
./retrieve_and_decrypt.sh <GROUP_ID> <IPFS_CID>
```

**Arguments:**
- `GROUP_ID` - NOVA group name (e.g., `my_campaign`)
- `IPFS_CID` - IPFS content identifier starting with `Qm` or `bafy`

**Output:** Decrypted file contents to stdout

**Exit codes:**
- `0` - Success
- `1` - Authentication failed or unauthorized
- `2` - File not found or decryption failed

### check_auth.sh

```bash
./check_auth.sh <GROUP_ID>
```

**Output:** JSON with authorization status

```json
{
  "authorized": true,
  "groups": ["my_campaign", "demo_group"],
  "member_count": 3
}
```

## Troubleshooting

### "Unauthorized" error

The agent's NEAR account is not a member of the group:
```bash
nova group add-member GROUP_ID agent-account.near
```

### "File not found" error

Check the IPFS CID is correct:
```bash
# Should return encrypted data
curl https://gateway.pinata.cloud/ipfs/YOUR_CID
```

### Decryption fails

Ensure the file was uploaded to the correct group. Keys are group-specific.

## Integration with Other Skills

This skill is designed to work with:

| Skill | Purpose |
|-------|---------|
| `near-email-skill` | Send emails via NEAR Email after retrieving contacts |
| `market-skill` | Accept jobs and submit deliverables on market.near.ai |
| `email-workflow-skill` | End-to-end campaign orchestration |

## License

MIT

## Links

- [NOVA SDK](https://nova-sdk.com)
- [NEAR AI Cloud](https://cloud.near.ai)
- [OpenClaw](https://near.ai/openclaw)
- [NEAR AI Agent Market](https://market.near.ai)
- [NEAR Email](https://near.email)
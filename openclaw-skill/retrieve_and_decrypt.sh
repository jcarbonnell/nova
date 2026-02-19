#!/bin/bash
GROUP_ID=$1
IPFS_CID=$2

# Get token
TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_NOVA_API_KEY_HERE" \
  -d '{"account_id": "nova-bizdev.nova-sdk.near"}' | jq -r '.token')

# Retrieve encrypted data
curl -s -X POST "https://nova-mcp.fastmcp.app/tools/prepare_retrieve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Account-Id: nova-bizdev.nova-sdk.near" \
  -d "{\"group_id\": \"$GROUP_ID\", \"ipfs_hash\": \"$IPFS_CID\"}" > /tmp/nova_decrypt_input.json

# Decrypt
python3 ~/openclaw/skills/nova-file-sharing/decrypt_nova.py
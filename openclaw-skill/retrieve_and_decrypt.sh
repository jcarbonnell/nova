#!/bin/bash
GROUP_ID=$1
IPFS_CID=$2

# Get token
TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${NOVA_API_KEY}" \
  -d '{"account_id": "nova-bizdev.nova-sdk.near"}' | jq -r '.token')

# Retrieve encrypted data
curl -s -X POST "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network/tools/prepare_retrieve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-account-id: nova-bizdev.nova-sdk.near" \
  -H "x-wallet-id: nova-bizdev.nova-sdk.near" \
  -d "{\"group_id\": \"$GROUP_ID\", \"ipfs_hash\": \"$IPFS_CID\"}" | jq '.result' > /tmp/nova_decrypt_input.json

# Decrypt
python3 ~/openclaw/skills/nova-file-sharing/decrypt_nova.py
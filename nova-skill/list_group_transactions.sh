#!/bin/bash
# list_group_transactions.sh — list all file transactions in a NOVA group
# Usage: list_group_transactions.sh GROUP_ID
set -euo pipefail

GROUP_ID="${1:?Usage: list_group_transactions.sh GROUP_ID}"

TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${NOVA_API_KEY}" \
  -d "{\"account_id\": \"${NOVA_ACCOUNT_ID}\"}" | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to get session token" >&2
  exit 1
fi

curl -s -X POST "${NOVA_MCP_URL}/tools/get_group_transactions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-account-id: ${NOVA_ACCOUNT_ID}" \
  -H "x-wallet-id: ${NOVA_ACCOUNT_ID}" \
  -d "{\"group_id\": \"${GROUP_ID}\"}" | jq '.result'
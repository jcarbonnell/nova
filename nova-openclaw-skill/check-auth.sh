#!/bin/bash
# check_auth.sh — verify agent is authorized for a NOVA group
set -euo pipefail

GROUP_ID="${1:?Usage: check_auth.sh GROUP_ID}"

TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${NOVA_API_KEY}" \
  -d "{\"account_id\": \"${NOVA_ACCOUNT_ID}\"}" | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo '{"error": "Failed to get session token — check NOVA_API_KEY and NOVA_ACCOUNT_ID"}' >&2
  exit 1
fi

curl -s -X POST "${NOVA_MCP_URL}/tools/auth_status" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-account-id: ${NOVA_ACCOUNT_ID}" \
  -H "x-wallet-id: ${NOVA_ACCOUNT_ID}" \
  -d "{\"group_id\": \"${GROUP_ID}\"}" | jq '.result'
#!/bin/bash
# retrieve_and_decrypt.sh — fetch and decrypt a file from a NOVA group
set -euo pipefail

GROUP_ID="${1:?Usage: retrieve_and_decrypt.sh GROUP_ID IPFS_CID}"
IPFS_CID="${2:?Usage: retrieve_and_decrypt.sh GROUP_ID IPFS_CID}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP_FILE="/tmp/nova_decrypt_input_$$.json"

cleanup() { rm -f "$TMP_FILE"; }
trap cleanup EXIT

TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${NOVA_API_KEY}" \
  -d "{\"account_id\": \"${NOVA_ACCOUNT_ID}\"}" | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to get session token" >&2
  exit 1
fi

curl -s -X POST "${NOVA_MCP_URL}/tools/prepare_retrieve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-account-id: ${NOVA_ACCOUNT_ID}" \
  -H "x-wallet-id: ${NOVA_ACCOUNT_ID}" \
  -d "{\"group_id\": \"${GROUP_ID}\", \"ipfs_hash\": \"${IPFS_CID}\"}" \
  | jq '.result' > "$TMP_FILE"

if [ "$(cat "$TMP_FILE")" = "null" ] || [ ! -s "$TMP_FILE" ]; then
  echo "ERROR: Failed to retrieve encrypted data — check group ID and CID" >&2
  exit 2
fi

python3 "${SKILL_DIR}/decrypt_nova.py" "$TMP_FILE"
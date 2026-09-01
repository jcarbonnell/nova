#!/bin/bash
# upload_to_nova.sh — encrypt and upload a file to a NOVA group
# Usage: upload_to_nova.sh GROUP_ID /path/to/file
# Returns: IPFS CID of the encrypted file
set -euo pipefail

GROUP_ID="${1:?Usage: upload_to_nova.sh GROUP_ID FILE_PATH}"
FILE_PATH="${2:?Usage: upload_to_nova.sh GROUP_ID FILE_PATH}"
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILENAME=$(basename "$FILE_PATH")

if [ ! -f "$FILE_PATH" ]; then
  echo "ERROR: File not found: $FILE_PATH" >&2
  exit 1
fi

# Step 1 — get session token
TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ${NOVA_API_KEY}" \
  -d "{\"account_id\": \"${NOVA_ACCOUNT_ID}\"}" | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: Failed to get session token" >&2
  exit 1
fi

# Step 2 — prepare upload (get encryption key + upload_id)
PREPARE=$(curl -s -X POST "${NOVA_MCP_URL}/tools/prepare_upload" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-account-id: ${NOVA_ACCOUNT_ID}" \
  -H "x-wallet-id: ${NOVA_ACCOUNT_ID}" \
  -d "{\"group_id\": \"${GROUP_ID}\", \"filename\": \"${FILENAME}\"}")

ENCRYPTION_KEY=$(echo "$PREPARE" | jq -r '.result.key')
UPLOAD_ID=$(echo "$PREPARE" | jq -r '.result.upload_id')

if [ -z "$ENCRYPTION_KEY" ] || [ "$ENCRYPTION_KEY" = "null" ]; then
  echo "ERROR: prepare_upload failed — no encryption key returned" >&2
  echo "$PREPARE" >&2
  exit 1
fi

# Step 3 — compute SHA-256 of plaintext BEFORE encryption
FILE_HASH=$(sha256sum "$FILE_PATH" | awk '{print $1}')

# Step 4 — encrypt the file client-side
ENCRYPTED_B64=$(python3 "${SKILL_DIR}/encrypt_nova.py" "$ENCRYPTION_KEY" "$FILE_PATH")

if [ -z "$ENCRYPTED_B64" ]; then
  echo "ERROR: Encryption failed" >&2
  exit 1
fi

# Step 5 — finalize upload (IPFS + NEAR transaction recorded server-side)
UPLOAD_RESULT=$(curl -s -X POST "${NOVA_MCP_URL}/tools/finalize_upload" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "x-account-id: ${NOVA_ACCOUNT_ID}" \
  -H "x-wallet-id: ${NOVA_ACCOUNT_ID}" \
  -d "{\"upload_id\": \"${UPLOAD_ID}\", \"encrypted_data\": \"${ENCRYPTED_B64}\", \"file_hash\": \"${FILE_HASH}\"}")

IPFS_CID=$(echo "$UPLOAD_RESULT" | jq -r '.result.cid // .result.ipfs_hash // empty')

if [ -z "$IPFS_CID" ] || [ "$IPFS_CID" = "null" ]; then
  echo "ERROR: Upload to IPFS failed" >&2
  echo "$UPLOAD_RESULT" >&2
  exit 1
fi

echo "$IPFS_CID"
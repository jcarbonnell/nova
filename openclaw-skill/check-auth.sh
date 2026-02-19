#!/bin/bash
GROUP_ID=$1

TOKEN=$(curl -s -X POST "https://nova-sdk.com/api/auth/session-token" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_NOVA_API_KEY_HERE" \
  -d '{"account_id": "nova-bizdev.nova-sdk.near"}' | jq -r '.token')

curl -s -X POST "https://nova-mcp.fastmcp.app/tools/auth_status" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Account-Id: nova-bizdev.nova-sdk.near" \
  -d "{\"group_id\": \"$GROUP_ID\"}"
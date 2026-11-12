#!/usr/bin/env bash
# 7.4 smoke test — trips the /rpc/user-keys/store limiter WITHOUT storing keys.
# The limiter runs before input validation, so an empty body still increments
# the window, then fails Zod (400) — until call 31, where the limiter throws 429
# BEFORE validation. No handler execution => no KV writes.

SHADE_URL="https://7e9ff97d35e21fdd0f5c819472217d19e772d017-3000.dstack-base-prod5.phala.network"
# Read the secret from env — never paste it inline (your working practice).
: "${INTERNAL_API_SECRET:?set INTERNAL_API_SECRET in your shell env first}"

echo "Firing 35 requests at /rpc/user-keys/store (empty body, valid gate)..."
for i in $(seq 1 35); do
  code=$(curl -s -o /tmp/store_resp.json -w "%{http_code}" \
    -X POST "$SHADE_URL/rpc/user-keys/store" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Auth: $INTERNAL_API_SECRET" \
    -d '{}')
  body=$(cat /tmp/store_resp.json)
  printf "%2d → %s  %s\n" "$i" "$code" "$body"
done
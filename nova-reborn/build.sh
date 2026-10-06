#!/usr/bin/env bash
#
# Build the nova-reborn WASM tool into a Reborn-installable component.
#
# Produces, in this directory:
#   nova-reborn.wasm        the component, ready to import into the dashboard
#   extension.toml          the v3 manifest (already present; left in place)
#
# Prerequisites on the BUILD machine (not the agent):
#   rustup target add wasm32-wasip2
#   cargo install wasm-tools
#
# Usage:
#   ./build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CRATE_NAME="nova_reborn"   # cargo replaces - with _ in artifact names
# Output straight into the bundle layout the manifest references:
# [runtime] module = "wasm/nova_reborn.wasm". Keeps the repo = the bundle.
OUT_DIR="wasm"
OUT_NAME="wasm/nova_reborn"

echo "→ building for wasm32-wasip2 (release)"
mkdir -p "$OUT_DIR"
cargo build --release --target wasm32-wasip2

RAW_WASM="target/wasm32-wasip2/release/${CRATE_NAME}.wasm"
if [ ! -f "$RAW_WASM" ]; then
  echo "error: expected build artifact not found at $RAW_WASM" >&2
  exit 1
fi

echo "→ converting to a WASM component"
if wasm-tools component new "$RAW_WASM" -o "${OUT_NAME}.wasm" 2>/dev/null; then
  echo "  component created"
else
  echo "  already a component; copying"
  cp "$RAW_WASM" "${OUT_NAME}.wasm"
fi

echo "→ stripping"
wasm-tools strip "${OUT_NAME}.wasm" -o "${OUT_NAME}.wasm"

echo
echo "done:"
echo "  $ROOT/${OUT_NAME}.wasm"
echo "  $ROOT/manifest.toml"
#!/usr/bin/env bash
#
# Build the nova-submit WASM tool into an IronClaw-installable component.
#
# Produces, in this directory:
#   nova-submit.wasm                      the component, ready for `ironclaw tool install`
#   nova-submit-tool.capabilities.json    the sidecar (already present; left in place)
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

CRATE_NAME="nova_submit_tool"   # cargo replaces - with _ in artifact names
OUT_NAME="nova-submit"

echo "→ building for wasm32-wasip2 (release)"
cargo build --release --target wasm32-wasip2

RAW_WASM="target/wasm32-wasip2/release/${CRATE_NAME}.wasm"
if [ ! -f "$RAW_WASM" ]; then
  echo "error: expected build artifact not found at $RAW_WASM" >&2
  exit 1
fi

echo "→ converting to a WASM component"
# wasm32-wasip2 output is usually already a component; `component new` is a
# no-op-safe normalization. If it errors because the module is already a
# component, fall back to copying.
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
echo "  $ROOT/${OUT_NAME}-tool.capabilities.json"
echo
echo "Install on the agent with:"
echo "  ironclaw tool install ${OUT_NAME}.wasm"
#!/usr/bin/env python3
# mcp-server/mutate-i2.py
#
# §5.13 MCP I2: mutation check for test-d2a-wallet-writes.py I2a–I2e.
# Each mutant edits ONE line of server.py (exact text, found once), runs the
# harness, and must turn the named checks FAIL. server.py is restored after each.
#
# Run (from mcp-server/, in the venv): python mutate-i2.py
import subprocess, sys
from pathlib import Path

SERVER = Path(__file__).parent / "server.py"
MUTANTS = [
    ("J1 an unknown tx taken as known", "        if not _is_unknown_tx(known):", "        if True:", ["I2a", "I2c"]),
    ("J2 no retry for a just-sent tx", "        if attempt + 1 == TX_KNOWN_ATTEMPTS:", "        if True:", ["I2a", "I2c"]),
    ("J3 any RPC error read as unknown", '    return (err.get("cause") or {}).get("name") == "UNKNOWN_TRANSACTION"', "    return bool(err)", ["I2e"]),
    ("J4 an RPC error on the first lookup ignored", '    if known.get("error"):', "    if False:", ["I2e"]),
    ("J5 the outcome not awaited to FINAL", 'data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, "FINAL")', 'data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, "NONE")', ["I2b"]),
]

def run():
    r = subprocess.run([sys.executable, "test-d2a-wallet-writes.py"], cwd=SERVER.parent,
                       capture_output=True, text=True, timeout=300)
    return r.stdout

if "37/37 passed" not in run():
    print("baseline not green: fix the harness first"); sys.exit(1)

caught = 0
src = SERVER.read_text()
for name, old, new, expect in MUTANTS:
    if src.count(old) != 1:
        print(f"  ✗ {name}: target found {src.count(old)} times"); continue
    try:
        SERVER.write_text(src.replace(old, new))
        out = run()
        missed = [t for t in expect if f"✗ {t}_" not in out]
        if not missed:
            caught += 1; print(f"  ✓ {name} → {', '.join(expect)} ✗")
        else:
            print(f"  ✗ {name}: still passing: {', '.join(missed)}")
    finally:
        SERVER.write_text(src)
print(f"\n{caught}/{len(MUTANTS)} mutants caught")
sys.exit(0 if caught == len(MUTANTS) else 1)

#!/usr/bin/env python3
# mcp-server/mutate-v049.py
#
# §5.13 MCP v49: mutation check for test-mcp-v049-tx-timeout.py.
# Each mutant edits ONE spot of server.py (exact text, found once), runs the
# harness, and must turn the named checks ✗. server.py is restored after each.
#
# Run (from mcp-server/, in the venv): python mutate-v049.py
import subprocess, sys
from pathlib import Path

SERVER = Path(__file__).parent / "server.py"
MUTANTS = [
    ("W1 a timeout not recovered (v48 behaviour)", "        except RPCTimeoutError as e:\n            tx_hash = getattr(e, \"trx_hash\", None)\n            if not tx_hash:\n                raise",
     "        except RPCTimeoutError as e:\n            tx_hash = None\n            if not tx_hash:\n                raise", ["V1", "V3", "V8"]),
    ("W2 the lookup names the contract as sender", 'r = await _await_sent_tx(tx_hash, user["near_account_id"])',
     'r = await _await_sent_tx(tx_hash, config["contract_id"])', ["V1"]),
    ("W3 a timed-out call sent again", 'r = await _await_sent_tx(tx_hash, user["near_account_id"])',
     'return await acc.function_call(contract_id=config["contract_id"], method_name=method_name, args=args, amount=total_attach, gas=gas)',
     ["V1", "V4"]),
    ("W4 an unknown tx not looked up again", "            continue\n        data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, \"FINAL\")",
     "            break\n        data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, \"FINAL\")", ["V3"]),
    ("W5 the outcome not awaited to FINAL", 'data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, "FINAL")\n        result',
     'data = await _rpc_tx_call(rpc_url, tx_hash, sender_id, "NONE")\n        result', ["V1"]),
    ("W6 py-near's own wait kept", "JsonProvider.wait_for_trx = _pynear_fail_fast\n", "\n", ["V5"]),
    ("W7 the recovered outcome's status dropped", 'return SimpleNamespace(status=r["status"],', 'return SimpleNamespace(status={},', ["V1", "V2"]),
]


def run():
    r = subprocess.run([sys.executable, "test-mcp-v049-tx-timeout.py"], cwd=SERVER.parent,
                       capture_output=True, text=True, timeout=600)
    return r.stdout

if "9/9 passed" not in run():
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

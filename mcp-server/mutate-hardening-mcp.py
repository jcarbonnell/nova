#!/usr/bin/env python3
# mcp-server/mutate-hardening-mcp.py
#
# §5.12 hardening, MCP side: mutation check for test-fix-a-mcp-auth.py T13/T14.
# Each mutant edits ONE line of server.py (exact text, found once), runs the
# harness, and must turn the named checks FAIL. server.py is restored after each.
#
# Run (from mcp-server/, in the venv): python mutate-hardening-mcp.py
import subprocess, sys
from pathlib import Path

SERVER = Path(__file__).parent / "server.py"
MUTANTS = [
    ("A1 the old audience default back",
     'SESSION_TOKEN_AUDIENCE = os.getenv("SESSION_TOKEN_AUDIENCE")',
     'SESSION_TOKEN_AUDIENCE = os.getenv("SESSION_TOKEN_AUDIENCE", "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network")',
     ["T14"]),
    ("A2 an unset audience not refused up front",
     "    if not SESSION_TOKEN_SECRET or not SESSION_TOKEN_AUDIENCE:",
     "    if not SESSION_TOKEN_SECRET:",
     ["T13"]),
]

def run():
    r = subprocess.run([sys.executable, "test-fix-a-mcp-auth.py"], cwd=SERVER.parent,
                       capture_output=True, text=True, timeout=300)
    return r.stdout

if "TESTS PASSED" not in run():
    print("baseline not green: fix the harness first"); sys.exit(1)

caught = 0
src = SERVER.read_text()
for name, old, new, expect in MUTANTS:
    if src.count(old) != 1:
        print(f"  ✗ {name}: target found {src.count(old)} times"); continue
    try:
        SERVER.write_text(src.replace(old, new))
        out = run()
        missed = [t for t in expect if f"[FAIL] {t} " not in out]
        if not missed:
            caught += 1; print(f"  ✓ {name} → {', '.join(expect)} FAIL")
        else:
            print(f"  ✗ {name}: still passing: {', '.join(missed)}")
    finally:
        SERVER.write_text(src)
print(f"\n{caught}/{len(MUTANTS)} mutants caught")
sys.exit(0 if caught == len(MUTANTS) else 1)

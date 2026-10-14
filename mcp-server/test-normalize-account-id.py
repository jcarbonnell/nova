"""test-normalize-account-id.py — harness for MCP v0.4.5 (implicit accounts).

Proves the REAL normalize_account_id from server.py, without importing the
server (no fastmcp / py_near / env needed): the harness parses server.py with
`ast`, pulls out exactly the definitions the function depends on (CONFIG,
get_config, IMPLICIT_ACCOUNT_RE, NEAR_ACCOUNT_MAX_LEN, normalize_account_id)
and executes ONLY those. What runs is the deployed source text, not a copy.

Callers: add_group_member and revoke_group_member (member_id).

Run from mcp-server/:
    python3 test-normalize-account-id.py            # default ./server.py
    python3 test-normalize-account-id.py path/to/server.py
"""
import ast
import os
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
WANT = {"CONFIG", "get_config", "IMPLICIT_ACCOUNT_RE", "NEAR_ACCOUNT_MAX_LEN", "normalize_account_id"}

for k in ("ACCOUNT_SUFFIX", "TESTNET_ACCOUNT_SUFFIX"):  # assert the deployed defaults
    os.environ.pop(k, None)

tree = ast.parse(open(SRC).read(), SRC)
picked, found = [], set()
for node in tree.body:
    names = set()
    if isinstance(node, ast.FunctionDef):
        names = {node.name}
    elif isinstance(node, ast.Assign):
        names = {t.id for t in node.targets if isinstance(t, ast.Name)}
    if names & WANT:
        picked.append(node)
        found |= names & WANT
missing = WANT - found
if missing:
    print(f"FATAL: {SRC} lacks {sorted(missing)} — is the v0.4.5 edit applied?")
    sys.exit(2)

ns = {"os": os, "re": re}
exec(compile(ast.Module(body=picked, type_ignores=[]), SRC, "exec"), ns)
norm = ns["normalize_account_id"]

passed = failed = 0
def check(name, cond, extra=""):
    global passed, failed
    print(f"  {'✅' if cond else '❌'} {name}" + (f"\n       {extra}" if extra and not cond else ""))
    if cond: passed += 1
    else: failed += 1

def out(x):
    try: return norm(x)
    except ValueError as e: return f"ValueError: {e}"

HEX = "a3" * 32                    # 64 lowercase hex
print("\nnormalize_account_id — MCP v0.4.5\n")

print("Unchanged behaviour (regression):")
check("named mainnet account passes through", out("alice.near") == "alice.near")
check("full custodial id passes through", out("gmail-14.nova-sdk.near") == "gmail-14.nova-sdk.near")
check("testnet id passes through", out("ironclaw-swarm-agent1.nova-sdk-7.testnet") == "ironclaw-swarm-agent1.nova-sdk-7.testnet")
check("bare custodial username gets the mainnet suffix", out("gmail-14") == "gmail-14.nova-sdk.near", out("gmail-14"))
check("whitespace + case are normalised", out("  Gmail-14 ") == "gmail-14.nova-sdk.near", out("  Gmail-14 "))
check("1-char username still rejected", out("a").startswith("ValueError"))
check("illegal chars still rejected", out("bad name!").startswith("ValueError"))
check("empty still rejected", out("").startswith("ValueError"))
check("50-char username (longest that fits) still suffixed",
      out("u" * 50) == "u" * 50 + ".nova-sdk.near" and len(out("u" * 50)) == 64)

print("\nImplicit accounts (the fix):")
check("64 lowercase hex → returned as-is (NOT suffixed)", out(HEX) == HEX, out(HEX))
check("64 UPPERCASE hex → lowercased, as-is", out(HEX.upper()) == HEX, out(HEX.upper()))
check("64 hex with surrounding whitespace → trimmed, as-is", out(f"  {HEX}\n") == HEX)
check("a second 64-hex id round-trips unchanged", out("98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de") == "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de")

print("\nOverlong suffixed names now refused (were silently invalid):")
check("63 hex (not implicit) → refused, not '<63hex>.nova-sdk.near'", out("a" * 63).startswith("ValueError"), out("a" * 63))
check("51-char username → refused (65-char result)", out("u" * 51).startswith("ValueError"), out("u" * 51))
check("64 chars with a non-hex letter → refused", out("g" + "a" * 63).startswith("ValueError"), out("g" + "a" * 63))
check("65 hex → refused", out("a" * 65).startswith("ValueError"))

print("\nPinned deferral (unchanged on purpose):")
eth = "0x" + "ab" * 20
check("ETH-implicit '0x'+40 hex is still treated as a username (deferred, see roadmap)",
      out(eth) == eth + ".nova-sdk.near", out(eth))

print(f"\n{'─' * 60}\n  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

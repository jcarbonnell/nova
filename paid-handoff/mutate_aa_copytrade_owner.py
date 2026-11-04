#!/usr/bin/env python3
"""
mutate_aa_copytrade_owner.py: every mutant of aa_copytrade_owner.py must be caught by its harness.
One anchored replacement per mutant (the anchor must occur exactly once), written to a temporary file and run
through test_aa_copytrade_owner.py with OWNER_MODULE pointing at it. The unmutated module must pass first.

    .venv/bin/python mutate_aa_copytrade_owner.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE = HERE / "aa_copytrade_owner.py"
HARNESS = HERE / "test_aa_copytrade_owner.py"
SRC = MODULE.read_text()

MUTANTS = [
    # seller revision 5
    ("O1", "NEAR transfer guard dropped", 'if near.get("transfer") is not False:', "if False:"),
    ("O2", "sign_message/call guard dropped", 'if near.get("sign_message") != [NOVA_CONTRACT] or near.get("call") != [NOVA_CONTRACT]:', "if False:"),
    ("O3", "revision 4 fields not checked", "if current.get(field) != SELLER_V4[field]:", "if False:"),
    ("O4", "USDC cap not checked", 'if per_tx.get(USDC) != SELLER_V4["usdc_cap"]:', "if False:"),
    ("O5", "assets not checked", 'if assets == "any" or not isinstance(assets, list) or USDC not in assets or WNEAR not in assets:', "if False:"),
    ("O6", "withdraw kept", '"actions": ["swap"],', '"actions": ["swap", "withdraw"],'),
    ("O7", "confidential not turned on", 'new["confidential"] = SELLER_V5["confidential"]', "pass"),
    ("O8", "action cap not raised", 'new["max_actions_per_hour"] = SELLER_V5["max_actions_per_hour"]', "pass"),
    ("O9", "wNEAR cap ten times too high", '"wnear_cap": "60000000000000000000000",', '"wnear_cap": "600000000000000000000000",'),
    ("O10", "daily budget not set", 'new.setdefault("budget", {})["daily_usd"] = SELLER_V5["daily_usd"]', "pass"),
    ("O11", "the policy in force is modified", 'new = copy.deepcopy(current)\n    new["actions"]', 'new = current\n    new["actions"]'),
    # seller revision 6
    ("O22", "revision 6 sets another mode", 'SELLER_V6 = {"destinations_mode": "any"}', 'SELLER_V6 = {"destinations_mode": "except"}'),
    ("O23", "revision 6 not built from revision 5", '        if current.get(field) != SELLER_V5[field]:', '        if False:'),
    ("O24", "revision 6 ignores the wNEAR cap", 'if ((current.get("limits") or {}).get("per_transaction") or {}).get(WNEAR) != SELLER_V5["wnear_cap"]:', 'if False:'),
    ("O25", "revision 6 built over any destinations", 'if not isinstance(dest, dict) or dest.get("mode") != "only":', 'if not isinstance(dest, dict):'),
    ("O26", "revision 6 drops the list", '    new["destinations"]["mode"] = SELLER_V6["destinations_mode"]', '    new["destinations"] = {"mode": SELLER_V6["destinations_mode"], "list": []}'),
    ("O27", "revision 6 modifies the policy in force", '    new = copy.deepcopy(current)\n    new["destinations"]', '    new = current\n    new["destinations"]'),
    ("O28", "revision 6 skips the NOVA-only guard", '    _native_nova_only(current)\n    for field in ("actions", "confidential", "max_actions_per_hour"):\n        if current.get(field) != SELLER_V5[field]:',
     '    for field in ("actions", "confidential", "max_actions_per_hour"):\n        if current.get(field) != SELLER_V5[field]:'),
    # follower
    ("O12", "the follower may pay anyone listed by an attacker", '"address": PROCEEDS, "memo": FOLLOWER_MEMO', '"address": "attacker.near", "memo": FOLLOWER_MEMO'),
    ("O13", "the follower may transfer", '"actions": ["withdraw", "swap"],', '"actions": ["withdraw", "swap", "transfer"],'),
    ("O14", "copy cap above the approved 0.15 USDC", '{USDC: "150000", WNEAR: "50000000000000000000000"}', '{USDC: "200000", WNEAR: "50000000000000000000000"}'),
    ("O15", "the follower may call NOVA", '"near": {"sign_message": [NOVA_CONTRACT], "transfer": False, "call": []},',
     '"near": {"sign_message": [NOVA_CONTRACT], "transfer": False, "call": ["x.near"]},'),
    ("O16", "the follower's confidential flag off", '"confidential": True,\n        "owner_approval": False,', '"confidential": False,\n        "owner_approval": False,'),
    # where each step may run
    ("O17", "follower created over an existing agent", "        if got:\n", "        if False:\n"),
    ("O18", "seller steps run anywhere", "    elif got != expected:", "    elif False:"),
    ("O19", "our flags reach aa_setup's parser", "    sys.argv = [sys.argv[0]]", "    pass"),
    ("O20", "the follower created with aa_setup's withdraw-only policy", "    aa_setup.POLICY = follower_policy()", "    pass"),
    ("O21", "every grant labelled as the seller's", 'aa_native.GRANT_LABEL = SELLER_GRANT_LABEL if role == "seller" else FOLLOWER_GRANT_LABEL',
     "aa_native.GRANT_LABEL = SELLER_GRANT_LABEL"),
]


def run(path: Path) -> int:
    env = {**os.environ, "OWNER_MODULE": str(path)}
    return subprocess.run([sys.executable, str(HARNESS)], cwd=HERE, env=env, capture_output=True, text=True, timeout=60).returncode


if run(MODULE) != 0:
    sys.exit("baseline harness fails")

caught, survived = 0, []
with tempfile.TemporaryDirectory(prefix="owner-mutants-") as d:
    for mid, what, anchor, repl in MUTANTS:
        n = SRC.count(anchor)
        if n != 1:
            sys.exit(f"{mid} anchor occurs {n} times, expected 1: {anchor!r}")
        f = Path(d) / f"mutant_{mid}.py"
        f.write_text(SRC.replace(anchor, repl))
        if run(f) != 0:
            caught += 1
            print(f"✓ {mid} caught: {what}")
        else:
            survived.append(mid)
            print(f"✗ {mid} SURVIVED: {what}")

print(f"\n{caught}/{len(MUTANTS)} mutants caught")
if survived:
    print("survived: " + ", ".join(survived))
    sys.exit(1)
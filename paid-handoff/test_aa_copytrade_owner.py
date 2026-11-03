#!/usr/bin/env python3
"""
test_aa_copytrade_owner.py: harness for aa_copytrade_owner.py's decisions (what the owner signs, and where).
No network, no keys, no owner signature: the pure functions are called directly, and aa_setup.main /
aa_native.grant are replaced by recorders.

    .venv/bin/python test_aa_copytrade_owner.py
    OWNER_MODULE=<path> .venv/bin/python test_aa_copytrade_owner.py     (the mutation script)
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
path = Path(os.environ.get("OWNER_MODULE", HERE / "aa_copytrade_owner.py"))
spec = importlib.util.spec_from_file_location("aa_copytrade_owner", path)
O = importlib.util.module_from_spec(spec)
spec.loader.exec_module(O)

USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
WNEAR = "nep141:wrap.near"
results: list[tuple[str, bool, str]] = []


def ok(name: str, passed: bool, detail: object = "") -> None:
    results.append((name, passed, "" if passed else json.dumps(detail, default=str)[:400]))
    print(f"{'✓' if passed else '✗'} {name}" + ("" if passed else f" — {results[-1][2]}"))


def refusal(f) -> str:
    try:
        f()
        return "no refusal"
    except O.Refused as e:
        return str(e)


# The seller's policy in force, exactly as observe-h2 read it on 2026-11-03 (revision 4).
V4 = {
    "frozen": False, "actions": ["withdraw"], "confidential": False, "owner_approval": False,
    "assets": [USDC, WNEAR],
    "limits": {"per_transaction": {WNEAR: "650000000000000000000000", USDC: "200000"}},
    "max_actions_per_hour": 5,
    "destinations": {"mode": "only", "list": [{"action": "withdraw", "chain": "near", "address": "1000fans.near", "memo": "listing:test"}]},
    "budget": {"daily_usd": "1", "weekly_usd": None, "monthly_usd": None}, "timelock_ms": 0,
    "native": {"near": {"sign_message": ["nova-sdk.near"], "transfer": False, "call": ["nova-sdk.near"]},
               "evm": {"sign_typed_data": [], "sign_message": False, "sign_transaction": False},
               "solana": {"sign_message": False, "sign_transaction": False}},
}

# ── seller revision 5 ───────────────────────────────────────────────────────────────────────
before = copy.deepcopy(V4)
v5 = O.seller_policy_v5(V4)
changes = O.changed_paths(V4, v5)
ok("S1 revision 5 changes exactly the five approved fields",
   changes == ["actions", "budget.daily_usd", "confidential", f"limits.per_transaction.{WNEAR}", "max_actions_per_hour"], changes)
ok("S2 to the approved values: swap only, confidential, 12 per hour, wNEAR cap 0.06 NEAR, $2 a day",
   v5["actions"] == ["swap"] and v5["confidential"] is True and v5["max_actions_per_hour"] == 12 and
   v5["limits"]["per_transaction"][WNEAR] == "60000000000000000000000" and v5["budget"]["daily_usd"] == "2", v5)
ok("S3 withdraw is dropped; USDC cap, assets, destinations, native and timelock are sent back unchanged",
   "withdraw" not in v5["actions"] and v5["limits"]["per_transaction"][USDC] == "200000" and v5["assets"] == V4["assets"] and
   v5["destinations"] == V4["destinations"] and v5["native"] == V4["native"] and v5["timelock_ms"] == 0 and
   v5["owner_approval"] is False and v5["frozen"] is False)
ok("S4 the policy in force is not modified", V4 == before)
ok("S5 0.06 NEAR is 6 × 10^22 yocto", int(v5["limits"]["per_transaction"][WNEAR]) == 6 * 10**22)


def with_(f):
    p = copy.deepcopy(V4)
    f(p)
    return p


bad = [
    ("native.near.transfer on", lambda p: p["native"]["near"].update(transfer=True), "native.near.transfer is not false"),
    ("native.near.call widened", lambda p: p["native"]["near"].update(call=["nova-sdk.near", "intents.near"]), "sign_message/call are not [nova-sdk.near]"),
    ("sign_message for another contract", lambda p: p["native"]["near"].update(sign_message=["other.near"]), "sign_message/call are not [nova-sdk.near]"),
    ("no native block", lambda p: p.pop("native"), "native.near.transfer is not false"),
    ("actions already changed", lambda p: p.update(actions=["withdraw", "transfer"]), "current actions"),
    ("confidential already on", lambda p: p.update(confidential=True), "current confidential"),
    ("another action cap", lambda p: p.update(max_actions_per_hour=7), "current max_actions_per_hour"),
    ("another USDC cap", lambda p: p["limits"]["per_transaction"].update({USDC: "250000"}), "current USDC per-transaction cap"),
    ("assets \"any\"", lambda p: p.update(assets="any"), "current assets must list USDC and wNEAR"),
    ("assets without wNEAR", lambda p: p.update(assets=[USDC]), "current assets must list USDC and wNEAR"),
]
fails = [f"{name}: {m}" for name, f, want in bad if want not in (m := refusal(lambda f=f: O.seller_policy_v5(with_(f))))]
ok(f"S6 anything but the revision 4 we read is refused before anything is signed ({len(bad)} cases)", not fails, fails)
ok("S7 a policy that is not an object is refused", "not an object" in refusal(lambda: O.seller_policy_v5(None)))

# ── the follower ────────────────────────────────────────────────────────────────────────────
f = O.follower_policy()
ok("F1 the follower pays only the proceeds account (1000fans.near), by withdraw on near",
   f["destinations"] == {"mode": "only", "list": [{"action": "withdraw", "chain": "near", "address": "1000fans.near", "memo": "copytrade"}]}, f["destinations"])
ok("F2 it may withdraw and swap, nothing else; confidential on; 10 actions per hour; $2 a day",
   f["actions"] == ["withdraw", "swap"] and f["confidential"] is True and f["max_actions_per_hour"] == 10 and f["budget"]["daily_usd"] == "2", f)
ok("F3 per-trade caps: 0.15 USDC, 0.05 NEAR; the 0.10 USDC price sits under the copy cap",
   f["limits"]["per_transaction"] == {USDC: "150000", WNEAR: str(5 * 10**22)} and 100000 < int(f["limits"]["per_transaction"][USDC]), f["limits"])
ok("F4 it signs in to NOVA only: sign_message nova-sdk.near, no NEAR transfer, no contract call",
   f["native"]["near"] == {"sign_message": ["nova-sdk.near"], "transfer": False, "call": []})
ok("F5 no owner approval, no timelock, not frozen, assets USDC and wNEAR",
   f["owner_approval"] is False and f["timelock_ms"] == 0 and f["frozen"] is False and f["assets"] == [USDC, WNEAR])

# ── where each step may run ─────────────────────────────────────────────────────────────────
SELLER = O.SELLER_AGENT_ID
ok("W1 the follower is created only in a directory that holds no agent yet",
   "already holds agent" in refusal(lambda: O.require_cwd_agent({"agent_id": SELLER}, None, "follower")) and
   refusal(lambda: O.require_cwd_agent({}, None, "follower")) == "no refusal")
ok("W2 seller steps run only where the seller's state is",
   "not the seller" in refusal(lambda: O.require_cwd_agent({"agent_id": "ff" * 32}, SELLER, "seller")) and
   "not the seller" in refusal(lambda: O.require_cwd_agent({}, SELLER, "seller")) and
   refusal(lambda: O.require_cwd_agent({"agent_id": SELLER}, SELLER, "seller")) == "no refusal")

calls: list[dict] = []
O.aa_setup.main = lambda: calls.append({"name": O.aa_setup.AGENT_NAME, "ext": O.aa_setup.EXTERNAL_USER_ID,
                                         "label": O.aa_setup.GRANT_LABEL, "policy": O.aa_setup.POLICY, "argv": list(sys.argv)})
sys.argv = ["aa_copytrade_owner.py", "--create-follower"]
O.create_follower()
c = calls[-1]
ok("W3 creating the follower sets aa_setup's name, external id, grant label and policy, and hides our flags from its parser",
   c["name"] == "nova-copytrade-follower-1" and c["ext"] == "nova-copytrade-follower-1" and c["label"] == "nova-copytrade-follower" and
   c["policy"] == O.follower_policy() and c["argv"] == ["aa_copytrade_owner.py"], {k: c[k] for k in ("name", "ext", "label", "argv")})

labels: list[str] = []
O.aa_native.grant = lambda m, api, state, rpc: labels.append(O.aa_native.GRANT_LABEL)
O.grant("seller", None, None, {}, "")
O.grant("follower", None, None, {}, "")
ok("W4 each role's grant carries its own label (never the seller's earlier nova-observation-native)",
   labels == ["nova-copytrade-seller", "nova-copytrade-follower"], labels)

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
if failed:
    print("failed:")
    for name, _, d in failed:
        print(f"  {name} — {d}")
    sys.exit(1)
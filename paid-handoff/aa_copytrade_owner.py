#!/usr/bin/env python3
"""
aa_copytrade_owner.py: H0 owner steps for the copy-trading demo (NEAR Hackathon). Approved 2026-11-03.

Reuses aa_setup.py and aa_native.py unchanged: their run_intent, guarded_signer, owner_key and
check_full_access sign every owner intent; aa_setup.main() creates the follower; aa_native.grant() issues
grants. Every file those scripts use (.env, aa-state.json, .grant-token) is resolved from the CURRENT
directory, so the seller is administered from ~/near/nova/paid-handoff and the follower from its own
directory, ~/near/nova/paid-handoff/follower-1 (with a symlink to ../.env); the two never share state.

    # seller (from ~/near/nova/paid-handoff)
    .venv/bin/python aa_copytrade_owner.py --status
    .venv/bin/python aa_copytrade_owner.py --seller-policy     # revision 5: one policy_update (nep366)
    .venv/bin/python aa_copytrade_owner.py --grant seller      # new 7-day grant "nova-copytrade-seller"

    # follower (from ~/near/nova/paid-handoff/follower-1)
    ../.venv/bin/python ../aa_copytrade_owner.py --create-follower   # agent_create + 7-day grant
    ../.venv/bin/python ../aa_copytrade_owner.py --grant follower    # later: a fresh 7-day grant

What gets signed is decided by the pure functions below (seller_policy_v5, follower_policy); their harness
is test_aa_copytrade_owner.py and runs without network or keys. Nothing secret is printed.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aa_setup  # noqa: E402
import aa_native  # noqa: E402

SELLER_AGENT_ID = "03363967db25b34a7940523a59975691f41f8b123bdeda93ac8c70a521a51986"  # nova-observation-1
NOVA_CONTRACT = "nova-sdk.near"
USDC = aa_setup.USDC
WNEAR = "nep141:wrap.near"
PROCEEDS = "1000fans.near"

# Seller revision 5 (approved 2026-11-03): swap only, confidential on, 12 actions per hour, wNEAR cap 0.06 NEAR,
# daily budget $2. Everything else is sent back exactly as the policy in force has it.
SELLER_V5 = {
    "actions": ["swap"],
    "confidential": True,
    "max_actions_per_hour": 12,
    "wnear_cap": "60000000000000000000000",   # 0.06 NEAR
    "daily_usd": "2",
}
# What revision 4 must look like before revision 5 is built (read on 2026-11-03, observe-h2).
SELLER_V4 = {
    "actions": ["withdraw"],
    "confidential": False,
    "max_actions_per_hour": 5,
    "usdc_cap": "200000",
}

# The follower (approved 2026-11-03): pays the listing (0.10 USDC) to the proceeds account only, copies trades
# up to 0.15 USDC each, reads NOVA (sign-in only, no NOVA writes), 10 actions per hour.
FOLLOWER_NAME = "nova-copytrade-follower-1"
FOLLOWER_EXTERNAL_ID = "nova-copytrade-follower-1"
FOLLOWER_GRANT_LABEL = "nova-copytrade-follower"
SELLER_GRANT_LABEL = "nova-copytrade-seller"
FOLLOWER_MEMO = "copytrade"


class Refused(Exception):
    pass


# ------------------------------------------------------------------------------ pure: what gets signed


def _native_nova_only(policy: dict) -> None:
    near = ((policy.get("native") or {}).get("near")) or {}
    if near.get("transfer") is not False:
        raise Refused("native.near.transfer is not false; refusing to sign a policy that can move NEAR out")
    if near.get("sign_message") != [NOVA_CONTRACT] or near.get("call") != [NOVA_CONTRACT]:
        raise Refused("native.near.sign_message/call are not [nova-sdk.near]; refusing")


def seller_policy_v5(current: dict) -> dict:
    """The seller's revision 5 from the policy in force. Refuses unless it is revision 4 as read on 2026-11-03."""
    if not isinstance(current, dict):
        raise Refused("current policy is not an object")
    _native_nova_only(current)
    for field in ("actions", "confidential", "max_actions_per_hour"):
        if current.get(field) != SELLER_V4[field]:
            raise Refused(f"current {field} is {current.get(field)!r}, expected revision 4's {SELLER_V4[field]!r}")
    per_tx = (current.get("limits") or {}).get("per_transaction") or {}
    if per_tx.get(USDC) != SELLER_V4["usdc_cap"]:
        raise Refused(f"current USDC per-transaction cap is {per_tx.get(USDC)!r}, expected {SELLER_V4['usdc_cap']!r}")
    assets = current.get("assets")
    if assets == "any" or not isinstance(assets, list) or USDC not in assets or WNEAR not in assets:
        raise Refused("current assets must list USDC and wNEAR (and not be \"any\")")

    new = copy.deepcopy(current)
    new["actions"] = list(SELLER_V5["actions"])
    new["confidential"] = SELLER_V5["confidential"]
    new["max_actions_per_hour"] = SELLER_V5["max_actions_per_hour"]
    new["limits"]["per_transaction"][WNEAR] = SELLER_V5["wnear_cap"]
    new.setdefault("budget", {})["daily_usd"] = SELLER_V5["daily_usd"]
    return new


def follower_policy() -> dict:
    """The follower's policy at creation."""
    p = {
        "frozen": False,
        "actions": ["withdraw", "swap"],
        "confidential": True,
        "owner_approval": False,
        "assets": [USDC, WNEAR],
        "limits": {"per_transaction": {USDC: "150000", WNEAR: "50000000000000000000000"}},  # 0.15 USDC, 0.05 NEAR
        "max_actions_per_hour": 10,
        "destinations": {"mode": "only",
                         "list": [{"action": "withdraw", "chain": "near", "address": PROCEEDS, "memo": FOLLOWER_MEMO}]},
        "budget": {"daily_usd": "2", "weekly_usd": None, "monthly_usd": None},
        "timelock_ms": 0,
        "native": {
            "near": {"sign_message": [NOVA_CONTRACT], "transfer": False, "call": []},
            "evm": {"sign_typed_data": [], "sign_message": False, "sign_transaction": False},
            "solana": {"sign_message": False, "sign_transaction": False},
        },
    }
    return p


def changed_paths(old, new, prefix: str = "") -> list[str]:
    """Every leaf path whose value differs, for the owner's review before signing."""
    if isinstance(old, dict) and isinstance(new, dict):
        out: list[str] = []
        for k in sorted(set(old) | set(new)):
            out += changed_paths(old.get(k), new.get(k), f"{prefix}.{k}" if prefix else k)
        return out
    return [] if old == new else [prefix]


# --------------------------------------------------------------------------------- owner operations


def require_cwd_agent(state: dict, expected: str | None, role: str) -> None:
    got = state.get("agent_id")
    if expected is None:
        if got:
            raise Refused(f"this directory already holds agent {got[:12]}…; the {role} needs its own directory")
    elif got != expected:
        raise Refused(f"this directory holds agent {str(got)[:12]}…, not the {role} ({expected[:12]}…); cd to the right directory")


def seller_policy(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    view = api.get_policy(agent_id)
    if not (view.get("status") == "APPLIED" and view.get("provider_policy_synced")):
        raise Refused(f"current policy not in force: {view.get('status')} synced={view.get('provider_policy_synced')}")
    current = view["policy"]
    if (current.get("actions") == SELLER_V5["actions"] and current.get("confidential") is True
            and current.get("max_actions_per_hour") == SELLER_V5["max_actions_per_hour"]):
        print(f"✓ revision 5 already in force (revision {view.get('revision')})")
        return
    new = seller_policy_v5(current)
    print("new policy (complete, as it will be signed):")
    print(json.dumps(new, indent=2))
    print("changes: " + ", ".join(changed_paths(current, new)))

    key = aa_setup.owner_key(m)
    aa_setup.check_full_access(m, key, rpc_url)
    sign = aa_setup.guarded_signer(m, key, rpc_url, api.get_network()["contract_id"])
    req = {"type": "policy_update", "agent_id": agent_id, "policy": new, "expected_revision": view["revision"]}
    st = aa_setup.run_intent(m, api, state, "policy_copytrade_v5", req, sign)
    if st["status"] != "SUCCESS":
        raise Refused(f"policy_update ended {st['status']} failure_code={st.get('failure_code')}")
    for _ in range(12):
        v = api.get_policy(agent_id)
        p = v.get("policy") or {}
        if (v.get("status") == "APPLIED" and v.get("provider_policy_synced") and p.get("actions") == SELLER_V5["actions"]
                and p.get("confidential") is True):
            state.pop("policy_copytrade_v5", None)
            aa_setup.save_state(state)
            print(f"✓ policy revision {v.get('revision')} APPLIED + synced")
            return
        print(f"· policy {v.get('status')} synced={v.get('provider_policy_synced')}; waiting")
        time.sleep(10)
    raise Refused("policy not in force after ~2 min; rerun --seller-policy later (it resumes)")


def create_follower() -> None:
    aa_setup.AGENT_NAME = FOLLOWER_NAME
    aa_setup.EXTERNAL_USER_ID = FOLLOWER_EXTERNAL_ID
    aa_setup.GRANT_LABEL = FOLLOWER_GRANT_LABEL
    aa_setup.POLICY = follower_policy()
    sys.argv = [sys.argv[0]]          # aa_setup.main() parses its own (empty) arguments
    aa_setup.main()


def grant(role: str, m, api, state, rpc_url: str) -> None:
    aa_native.GRANT_LABEL = SELLER_GRANT_LABEL if role == "seller" else FOLLOWER_GRANT_LABEL
    aa_native.grant(m, api, state, rpc_url)


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true")
    g.add_argument("--seller-policy", action="store_true")
    g.add_argument("--create-follower", action="store_true")
    g.add_argument("--grant", choices=["seller", "follower"])
    args = ap.parse_args()

    try:
        state = aa_setup.load_state() if aa_setup.STATE_FILE.exists() else {}
        if args.create_follower:
            require_cwd_agent(state, None, "follower")
            if not aa_setup.ENV_FILE.exists():
                raise Refused(f"{aa_setup.ENV_FILE} missing: in the follower directory, run `ln -s ../.env .env`")
            create_follower()
            return
        aa_setup.load_env(aa_setup.ENV_FILE)
        m = aa_setup.import_asset()
        rpc_url = __import__("os").environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
        api = m.AgentApi.from_env()
        if args.status:
            if not state.get("agent_id"):
                raise Refused("no agent in this directory")
            aa_native.status(m, api, state, rpc_url)
        elif args.seller_policy:
            require_cwd_agent(state, SELLER_AGENT_ID, "seller")
            seller_policy(m, api, state, rpc_url)
        else:
            if args.grant == "seller":
                require_cwd_agent(state, SELLER_AGENT_ID, "seller")
            elif state.get("agent_id") in (None, SELLER_AGENT_ID):
                raise Refused("--grant follower must run from the follower's directory")
            grant(args.grant, m, api, state, rpc_url)
    except Refused as e:
        aa_setup.die(str(e))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        aa_setup.die("interrupted (state saved; re-run resumes)")
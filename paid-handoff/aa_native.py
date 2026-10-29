#!/usr/bin/env python3
"""
aa_native.py: D2-0 owner steps for agent self-custodial writes (native.near.call on NOVA).

Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json; writes ./.grant-token).

    .venv/bin/python aa_native.py --status        # read-only: grant, native policy, agent NEAR account
    .venv/bin/python aa_native.py --grant         # owner issues a fresh 7-day grant (nep413)
    .venv/bin/python aa_native.py --enable-call   # owner allows native.near.call=[nova-sdk.near] (nep366)

--grant writes the new token to ./.grant-token.new (chmod 600) BEFORE the owner signs and moves it
to ./.grant-token only once the grant is SUCCESS. Nothing secret is printed.

--enable-call changes ONLY: native.near.call -> [nova-sdk.near]; assets += nep141:wrap.near
(native NEAR deposits count as wNEAR); limits.per_transaction[wrap.near] = WNEAR_CAP. Every other
policy field, including native.near.transfer=false and sign_message, is sent back unchanged.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aa_setup import (  # noqa: E402
    ENV_FILE, GRANT_FILE, check_full_access, die, guarded_signer, import_asset, load_env,
    load_state, owner_key, run_intent, save_state, write_private,
)

NOVA_CONTRACT = "nova-sdk.near"
WNEAR = "nep141:wrap.near"
WNEAR_CAP = "10000000000000000000000"  # 0.01 NEAR per call; record_transaction fee is 0.0000256
GRANT_LABEL = "nova-observation-native"
GRANT_DAYS = 7
NEW_GRANT_FILE = GRANT_FILE.with_name(".grant-token.new")


def near_account(api, agent_id: str) -> str:
    acct = (api.get_agent(agent_id).get("wallet") or {}).get("near_account_id")
    if not acct:
        die("agent has no wallet.near_account_id")
    return acct


def view_account(m, rpc_url: str, account_id: str) -> dict:
    r = m.httpx.post(rpc_url, json={"jsonrpc": "2.0", "id": "va", "method": "query", "params": {
        "request_type": "view_account", "finality": "final", "account_id": account_id}}, timeout=20).json()
    if "result" in r:
        return {"exists": True, "amount_near": int(r["result"]["amount"]) / 1e24,
                "storage_usage": r["result"]["storage_usage"]}
    cause = ((r.get("error") or {}).get("cause") or {}).get("name")
    if cause == "UNKNOWN_ACCOUNT":
        return {"exists": False}
    die(f"view_account indefinite answer: {r.get('error')}")


def status(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    acct = near_account(api, agent_id)
    p = api.get_policy(agent_id)
    now = datetime.now(timezone.utc)
    grants = []
    for g in api.list_grants(agent_id):
        exp = datetime.fromisoformat(g["expires_at"].replace("Z", "+00:00"))
        live = g.get("revoked_at") is None and exp > now
        grants.append({"grant_id": g["grant_id"][:12] + "…", "label": g["label"], "expires_at": g["expires_at"],
                       "live": live})
    pol = p.get("policy") or {}
    print(json.dumps({
        "agent_id": agent_id,
        "near_account_id": acct,
        "near_account_on_chain": view_account(m, rpc_url, acct),
        "policy": {"revision": p.get("revision"), "status": p.get("status"),
                   "synced": p.get("provider_policy_synced"),
                   "native.near": (pol.get("native") or {}).get("near"),
                   "assets": pol.get("assets"), "limits": pol.get("limits"),
                   "max_actions_per_hour": pol.get("max_actions_per_hour")},
        "cooldowns": api.get_agent(agent_id).get("cooldowns"),
        "grants": grants,
        "grant_file_present": GRANT_FILE.exists(),
    }, indent=2))


def grant(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    now = datetime.now(timezone.utc)
    for g in api.list_grants(agent_id):
        exp = datetime.fromisoformat(g["expires_at"].replace("Z", "+00:00"))
        if g.get("revoked_at") is None and exp > now and g["label"] == GRANT_LABEL:
            die(f"a live '{GRANT_LABEL}' grant already exists (expires {g['expires_at']}); not issuing another")

    saved = state.get("grant_native") or {}
    if saved.get("correlation_id") and not NEW_GRANT_FILE.exists():
        die(f"saved grant intent {saved['correlation_id']} but {NEW_GRANT_FILE} is missing: inspect before retrying")
    if not NEW_GRANT_FILE.exists():
        cred = m.create_grant_credential()
        write_private(NEW_GRANT_FILE, cred["token"] + "\n")
        state["grant_native_commitment"] = cred["commitment"]
        save_state(state)
    token = NEW_GRANT_FILE.read_text().strip()
    commitment = m.grant_commitment(token)
    if state.get("grant_native_commitment") != commitment:
        die(f"{NEW_GRANT_FILE} does not match the saved commitment: inspect before retrying")

    expires = (now + timedelta(days=GRANT_DAYS)).replace(microsecond=0)
    req = {"type": "grant_issue", "agent_id": agent_id, "label": GRANT_LABEL, "credential": commitment,
           "expires_at": expires.isoformat().replace("+00:00", "Z")}
    key = owner_key(m)
    check_full_access(m, key, rpc_url)
    sign = guarded_signer(m, key, rpc_url, api.get_network()["contract_id"])
    st = run_intent(m, api, state, "grant_native", req, sign)
    if st["status"] != "SUCCESS":
        die(f"grant_issue ended {st['status']} failure_code={st.get('failure_code')} (token kept in {NEW_GRANT_FILE})")

    os.replace(NEW_GRANT_FILE, GRANT_FILE)
    g = st["details"]["grant"]
    state["grant_id"] = g["grant_id"]
    state["grant_expires_at"] = g.get("expires_at")
    state.pop("grant_native", None)
    state.pop("grant_native_commitment", None)
    save_state(state)
    print(f"✓ grant {g['grant_id'][:12]}… issued, expires {g.get('expires_at')}; token moved to {GRANT_FILE}")


def enable_call(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    view = api.get_policy(agent_id)
    if not (view.get("status") == "APPLIED" and view.get("provider_policy_synced")):
        die(f"current policy not in force: {view.get('status')} synced={view.get('provider_policy_synced')}")
    policy = json.loads(json.dumps(view["policy"]))
    native = policy.get("native")
    if not native or native["near"].get("sign_message") != [NOVA_CONTRACT]:
        die("native.near.sign_message is not [nova-sdk.near]; run aa_identity.py --enable-native first")

    assets = policy["assets"]
    if assets != "any" and WNEAR not in assets:
        assets.append(WNEAR)
    per_tx = policy.setdefault("limits", {}).setdefault("per_transaction", {})
    if (native["near"].get("call") == [NOVA_CONTRACT] and (assets == "any" or WNEAR in view["policy"]["assets"])
            and per_tx.get(WNEAR) == WNEAR_CAP):
        print(f"✓ already enabled (revision {view.get('revision')})")
        return
    per_tx[WNEAR] = WNEAR_CAP
    native["near"]["call"] = [NOVA_CONTRACT]
    if native["near"].get("transfer") is not False:
        die("native.near.transfer is not false; refusing to send a policy that moves NEAR out")

    print("new policy (complete, as it will be signed):")
    print(json.dumps(policy, indent=2))
    print(f"changes: native.near.call=[{NOVA_CONTRACT}], assets += {WNEAR}, "
          f"limits.per_transaction[{WNEAR}]={int(WNEAR_CAP) / 1e24} NEAR")

    key = owner_key(m)
    check_full_access(m, key, rpc_url)
    sign = guarded_signer(m, key, rpc_url, api.get_network()["contract_id"])
    req = {"type": "policy_update", "agent_id": agent_id, "policy": policy, "expected_revision": view["revision"]}
    st = run_intent(m, api, state, "policy_native_call", req, sign)
    if st["status"] != "SUCCESS":
        die(f"policy_update ended {st['status']} failure_code={st.get('failure_code')}")
    for _ in range(12):
        v = api.get_policy(agent_id)
        n = ((v.get("policy") or {}).get("native") or {}).get("near", {})
        if v.get("status") == "APPLIED" and v.get("provider_policy_synced") and n.get("call") == [NOVA_CONTRACT]:
            state.pop("policy_native_call", None)
            save_state(state)
            print(f"✓ policy revision {v.get('revision')} APPLIED + synced; native.near.call=[{NOVA_CONTRACT}]")
            return
        print(f"· policy {v.get('status')} synced={v.get('provider_policy_synced')}; waiting")
        time.sleep(10)
    die("policy not in force after ~2 min; rerun --enable-call later (it resumes)")


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true")
    g.add_argument("--grant", action="store_true")
    g.add_argument("--enable-call", action="store_true")
    args = ap.parse_args()

    load_env(ENV_FILE)
    m = import_asset()
    rpc_url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
    api = m.AgentApi.from_env()
    state = load_state()
    if not state.get("agent_id"):
        die("no agent_id; run aa_setup.py first")
    if args.status:
        status(m, api, state, rpc_url)
    elif args.grant:
        grant(m, api, state, rpc_url)
    else:
        enable_call(m, api, state, rpc_url)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        die("interrupted (state saved; re-run resumes)")
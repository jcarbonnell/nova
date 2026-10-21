#!/usr/bin/env python3
"""
aa_setup.py: step B of the §5.18 observation. Creates ONE Agent Connect test agent with a
withdraw-only policy (USDC, to 1000fans.near, memo "listing:test"), then issues ONE grant.

Run from ~/near/nova/paid-handoff (reads ./.env; writes ./aa-state.json and ./.grant-token).

    .venv/bin/python aa_setup.py            # create agent (if needed) + grant (if needed)
    .venv/bin/python aa_setup.py --status   # read-only: show what exists

Secrets:
  - NEAR_INTENTS_AGENT_API_KEY comes from ./.env and is never printed.
  - The owner key is read from ~/.near-credentials/mainnet/<OWNER>.json and never printed.
  - The grant token is written to ./.grant-token (chmod 600) BEFORE the owner signs, never printed.

Guards before every owner signature (refuses to sign otherwise):
  - signer.account_id == OWNER;
  - nep366: payload.receiverId == contract_id from GET /v1/network, every action is a
    FunctionCall, and every deposit is at most MAX_DEPOSIT_YOCTO (shown in NEAR);
  - nep413: shows message + recipient;
  - then waits for you to type "sign".
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path.cwd()
ENV_FILE = HERE / ".env"
STATE_FILE = HERE / "aa-state.json"
GRANT_FILE = HERE / ".grant-token"

OWNER = "devbot.near"
RECIPIENT = "1000fans.near"
MEMO = "listing:test"
USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
AGENT_NAME = "nova-observation-1"
EXTERNAL_USER_ID = "nova-observation"
GRANT_LABEL = "nova-observation-withdraw"
GRANT_DAYS = 7
MAX_DEPOSIT_YOCTO = 50_000_000_000_000_000_000_000  # 0.05 NEAR: cap on any deposit the owner pays

POLICY = {
    "frozen": False,
    "actions": ["withdraw"],
    "confidential": False,
    "owner_approval": False,
    "assets": [USDC],
    "limits": {"per_transaction": {USDC: "200000"}},  # 0.20 USDC
    "max_actions_per_hour": 5,
    "destinations": {
        "mode": "only",
        "list": [{"action": "withdraw", "chain": "near", "address": RECIPIENT, "memo": MEMO}],
    },
    "budget": {"daily_usd": "1", "weekly_usd": None, "monthly_usd": None},
    "timelock_ms": 0,
}


# ------------------------------------------------------------------------------- plumbing


def die(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def load_env(path: Path) -> None:
    if not path.exists():
        die(f"{path} not found (run from ~/near/nova/paid-handoff)")
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def import_asset():
    default = Path.home() / "near/aa-skills/near-intents-agent-api/assets/python"
    sys.path.insert(0, str(Path(os.environ.get("AA_SKILLS_PY", default))))
    try:
        import near_intents_agent_api as m  # noqa: PLC0415
    except ImportError as e:
        die(f"cannot import near_intents_agent_api ({e}); set AA_SKILLS_PY or pip install httpx cryptography")
    return m


def write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def load_state() -> dict:
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}


def save_state(state: dict) -> None:
    write_private(STATE_FILE, json.dumps(state, indent=2) + "\n")


def owner_key(m):
    cred = Path.home() / f".near-credentials/mainnet/{OWNER}.json"
    if not cred.exists():
        die(f"no credentials file at {cred}")
    data = json.loads(cred.read_text())
    secret = data.get("private_key") or data.get("secret_key")
    if not secret:
        die(f"{cred} has no private_key")
    key = m.NearKey(secret)
    if data.get("public_key") and data["public_key"] != key.public_key:
        die("credentials file public_key does not match its private_key")
    return key


def check_full_access(m, key, rpc_url: str) -> None:
    rpc = m.httpx.post(
        rpc_url,
        json={"jsonrpc": "2.0", "id": "fa", "method": "query",
              "params": {"request_type": "view_access_key", "finality": "final",
                         "account_id": OWNER, "public_key": key.public_key}},
        timeout=20,
    ).json()
    res = rpc.get("result") or {}
    if "error" in rpc or "error" in res:
        die(f"view_access_key failed for {OWNER} / {key.public_key}: {rpc.get('error') or res.get('error')}")
    if res.get("permission") != "FullAccess":
        die(f"{key.public_key} is not a FullAccess key on {OWNER}")
    print(f"✓ owner key {key.public_key} is FullAccess on {OWNER}")


# ------------------------------------------------------------------------------ signing guard


def guarded_signer(m, key, rpc_url: str, contract_id: str):
    def sign(generated: dict) -> dict:
        intent = generated["intent"]
        standard, payload = intent["standard"], intent["payload"]
        signer = (generated.get("signer") or {}).get("account_id")
        print("\n── owner signature requested ─────────────────────────────")
        print(f"type:      {generated.get('type')}")
        print(f"intent id: {generated.get('correlation_id')}")
        print(f"standard:  {standard}")
        print(f"signer:    {signer}")
        print(f"summary:   {(generated.get('preview') or {}).get('summary')}")
        if signer != OWNER:
            die(f"signer is {signer!r}, expected {OWNER!r}; refusing to sign")
        if standard == "nep366":
            print(f"receiver:  {payload.get('receiverId')}")
            if payload.get("receiverId") != contract_id:
                die(f"receiverId {payload.get('receiverId')!r} != network contract {contract_id!r}; refusing")
            for i, a in enumerate(payload.get("actions", [])):
                p = a.get("params", {})
                print(f"action[{i}]: {a.get('type')} {p.get('methodName')} gas={p.get('gas')} deposit={p.get('deposit')}")
                if a.get("type") != "FunctionCall":
                    die(f"action[{i}] is {a.get('type')!r}, not FunctionCall; refusing")
                dep = int(p.get("deposit", "0"))
                if dep > MAX_DEPOSIT_YOCTO:
                    die(f"action[{i}] attaches {dep / 1e24:.5f} NEAR (> cap {MAX_DEPOSIT_YOCTO / 1e24} NEAR); refusing")
                if dep:
                    print(f"           ↳ {OWNER} pays {dep / 1e24:.5f} NEAR to {contract_id} (storage deposit; the sponsor pays only gas)")
        elif standard == "nep413":
            print(f"recipient: {payload.get('recipient')}")
            print("message:")
            print("  " + str(payload.get("message")).replace("\n", "\n  "))
        else:
            die(f"unexpected standard {standard!r} for a NEAR owner; refusing")
        print("──────────────────────────────────────────────────────────")
        if input('type "sign" to sign with the owner key: ').strip() != "sign":
            die("not signed")
        return m.sign_intent(generated, near_key=key, rpc_url=rpc_url)

    return sign


def run_intent(m, api, state: dict, step: str, request: dict, sign) -> dict:
    """generate → (persist) → sign → submit → wait. Resumes from a saved correlation id."""
    saved = state.get(step) or {}
    cid = saved.get("correlation_id")
    if cid:
        st = api.get_status(cid)
        print(f"· {step}: saved {cid} is {st['status']}")
        if st["status"] == "SUCCESS":
            return st
        if st["status"] not in ("PENDING_SIGNATURE", "FAILED"):
            print(f"· {step}: waiting on {cid}")
            return api.wait_for_status(cid, deadline_s=300)
        # PENDING_SIGNATURE (likely expired) or FAILED: new intent, new key
    idem = m.create_idempotency_key()
    generated = api.generate_intent(request, idem)
    state[step] = {"correlation_id": generated["correlation_id"], "idempotency_key": idem,
                   "agent_id": generated.get("agent_id"), "generated_at": datetime.now(timezone.utc).isoformat()}
    save_state(state)
    signed = sign(generated)
    api.submit_intent(generated["type"], generated["correlation_id"], signed)
    print(f"· {step}: submitted, polling {generated['correlation_id']}")
    return api.wait_for_status(generated["correlation_id"], deadline_s=300)


# ----------------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--status", action="store_true", help="read-only: show agent, policy, grants, balances")
    args = ap.parse_args()

    load_env(ENV_FILE)
    m = import_asset()
    rpc_url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
    api = m.AgentApi.from_env()

    net = api.get_network()
    print(f"✓ API {api.base_url}: network={net['network']} contract={net['contract_id']} overall={net['status']['overall']}")
    if net["network"] != "mainnet":
        die("expected mainnet")
    contract_id = net["contract_id"]

    tokens = {t["asset_id"]: t for t in api.get_tokens()}
    if USDC not in tokens or tokens[USDC]["decimals"] != 6:
        die("USDC asset id not in /v1/tokens with 6 decimals")

    state = load_state()

    if args.status:
        agent_id = state.get("agent_id")
        if not agent_id:
            print("no agent yet")
            return
        a = api.get_agent(agent_id)
        p = api.get_policy(agent_id)
        g = api.list_grants(agent_id)
        b = api.get_balances(agent_id, "public", USDC)
        print(json.dumps({
            "agent": {k: a.get(k) for k in ("id", "name", "status", "wallet", "cooldowns")},
            "policy": {k: p.get(k) for k in ("revision", "status", "provider_policy_synced", "policy")},
            "grants": [{k: x.get(k) for k in ("grant_id", "label", "expires_at", "revoked_at")} for x in g],
            "usdc": b,
        }, indent=2))
        return

    key = owner_key(m)
    check_full_access(m, key, rpc_url)
    sign = guarded_signer(m, key, rpc_url, contract_id)

    # 1. agent_create (policy included; agent_create starts no policy cooldown)
    if not state.get("agent_id"):
        req = {"type": "agent_create", "name": AGENT_NAME, "external_user_id": EXTERNAL_USER_ID,
               "owner": m.near_owner(OWNER, key), "policy": POLICY}
        st = run_intent(m, api, state, "agent_create", req, sign)
        if st["status"] != "SUCCESS":
            die(f"agent_create ended {st['status']} failure_code={st.get('failure_code')}")
        state["agent_id"] = st["details"]["agent_id"]
        save_state(state)
        print(f"✓ agent {state['agent_id']} created (tx {st['details'].get('transaction_hash')})")
    agent_id = state["agent_id"]

    # 2. policy in force?
    for _ in range(10):
        p = api.get_policy(agent_id)
        if p.get("status") == "APPLIED" and p.get("provider_policy_synced"):
            break
        print(f"· policy {p.get('status')} synced={p.get('provider_policy_synced')}; waiting")
        api.get_status(state["agent_create"]["correlation_id"], wait_ms=10_000)
    else:
        die("policy not APPLIED + synced after ~100 s; rerun with --status later")
    print(f"✓ policy revision {p.get('revision')} APPLIED and synced")

    # 3. grant_issue (token stored BEFORE the owner signs)
    if not state.get("grant_id"):
        if GRANT_FILE.exists():
            die(f"{GRANT_FILE} exists but no grant_id in state: inspect, then delete it to retry")
        cred = m.create_grant_credential()
        write_private(GRANT_FILE, cred["token"] + "\n")
        expires = (datetime.now(timezone.utc) + timedelta(days=GRANT_DAYS)).replace(microsecond=0)
        req = {"type": "grant_issue", "agent_id": agent_id, "label": GRANT_LABEL,
               "credential": cred["commitment"], "expires_at": expires.isoformat().replace("+00:00", "Z")}
        st = run_intent(m, api, state, "grant_issue", req, sign)
        if st["status"] != "SUCCESS":
            die(f"grant_issue ended {st['status']} failure_code={st.get('failure_code')} (token kept in {GRANT_FILE})")
        state["grant_id"] = st["details"]["grant"]["grant_id"]
        state["grant_expires_at"] = st["details"]["grant"].get("expires_at")
        save_state(state)
        print(f"✓ grant {state['grant_id']} issued, expires {state['grant_expires_at']}; token in {GRANT_FILE}")

    wallet = api.get_agent(agent_id).get("wallet") or {}
    print(f"\n✓ done. agent_id={agent_id} near_account_id={wallet.get('near_account_id')}")
    print("  next: step C (fund with USDC)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        die("interrupted")

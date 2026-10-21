#!/usr/bin/env python3
"""
aa_fund.py: step C of the §5.18 observation. Funds the test agent with 0.30 USDC via /deposit.

Run from ~/near/nova/paid-handoff (reads ./.env and ./aa-state.json from aa_setup.py).

    .venv/bin/python aa_fund.py --from devbot.near   # request a deposit address, print the send command
    .venv/bin/python aa_fund.py --wait                # after sending: poll until credited, show balance

It moves no funds itself: you send the USDC with the printed near-cli command.
Secrets: the API key comes from ./.env and is never printed. No owner key, no grant needed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aa_setup import (  # noqa: E402  reuse the same plumbing and constants
    ENV_FILE, USDC, die, import_asset, load_env, load_state, save_state,
)

AMOUNT = "300000"  # 0.30 USDC (6 decimals)
USDC_CONTRACT = USDC.removeprefix("nep141:")


def rpc_view(m, rpc_url: str, contract: str, method: str, args: dict):
    import base64
    r = m.httpx.post(rpc_url, json={"jsonrpc": "2.0", "id": "v", "method": "query", "params": {
        "request_type": "call_function", "finality": "final", "account_id": contract,
        "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode()}},
        timeout=20).json()
    res = r.get("result") or {}
    if "error" in r or "error" in res or "result" not in res:
        return ("error", r.get("error") or res.get("error"))
    return ("ok", json.loads(bytes(res["result"]).decode() or "null"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="funder", help="NEAR account that will send the USDC")
    ap.add_argument("--wait", action="store_true", help="poll the deposit until credited")
    args = ap.parse_args()

    load_env(ENV_FILE)
    m = import_asset()
    rpc_url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
    api = m.AgentApi.from_env()
    state = load_state()
    agent_id = state.get("agent_id") or die("no agent_id in aa-state.json; run aa_setup.py first")

    if args.wait:
        dep = state.get("deposit") or die("no deposit requested yet; run with --from first")
        st = api.wait_for_status(dep["correlation_id"], deadline_s=600)
        while st["status"] == "PENDING_DEPOSIT":
            print(f"· still PENDING_DEPOSIT (expires {st['details'].get('expires_at')}); polling")
            st = api.wait_for_status(dep["correlation_id"], deadline_s=600)
        print(f"status: {st['status']} failure_code={st.get('failure_code')}")
        print(json.dumps({k: st["details"].get(k) for k in
                          ("tx_hash", "destination_tx_hash", "amount_out", "refund_tx_hash", "failure_reason")}, indent=2))
        bal = api.get_balances(agent_id, "public", USDC)
        print(json.dumps(bal, indent=2))
        return

    if not args.funder:
        die("pass --from <account> (the account that will send the USDC)")

    if state.get("deposit"):
        dep = state["deposit"]
        print(f"· reusing saved deposit request {dep['correlation_id']} (same idempotency key → same address)")
    else:
        dep = {"idempotency_key": m.create_idempotency_key(), "body": {"origin_asset": USDC, "amount": AMOUNT}}
        state["deposit"] = dep
        save_state(state)  # persist key + body before sending

    st = api.deposit(agent_id, dep["body"], idempotency_key=dep["idempotency_key"])
    dep["correlation_id"] = st["correlation_id"]
    save_state(state)
    d = st["details"]
    addr, memo = d.get("deposit_address"), d.get("memo")
    print(f"status:          {st['status']}")
    print(f"deposit_address: {addr}")
    print(f"memo:            {memo}")
    print(f"min_amount:      {d.get('min_amount')}  (sending {AMOUNT})")
    print(f"expires_at:      {d.get('expires_at')}")
    print(f"refund_to:       {d.get('refund_to')}")
    if not addr:
        die("no deposit_address in the response; do not send anything")
    if d.get("min_amount") and int(d["min_amount"]) > int(AMOUNT):
        die(f"min_amount {d['min_amount']} > {AMOUNT}: do not send; tell Claude")

    ok, reg = rpc_view(m, rpc_url, USDC_CONTRACT, "storage_balance_of", {"account_id": addr})
    print(f"deposit address registered on USDC: {reg if ok == 'ok' else 'check failed: ' + str(reg)}")
    ok, bal = rpc_view(m, rpc_url, USDC_CONTRACT, "ft_balance_of", {"account_id": args.funder})
    print(f"{args.funder} USDC balance (atomic): {bal if ok == 'ok' else 'check failed: ' + str(bal)}")
    if ok == "ok" and int(bal or 0) < int(AMOUNT):
        die(f"{args.funder} holds less than 0.30 USDC")
    if ok == "ok" and reg is None:
        print("\nthe deposit address is not registered on USDC yet; register it first (0.00125 NEAR):")
        print(f"  near call {USDC_CONTRACT} storage_deposit '{{\"account_id\":\"{addr}\",\"registration_only\":true}}' \\")
        print(f"    --accountId {args.funder} --deposit 0.00125 --networkId mainnet")

    call = {"receiver_id": addr, "amount": AMOUNT}
    if memo:
        call["memo"] = memo
    print("\nsend it with (check the address against the line above first):")
    print(f"  near call {USDC_CONTRACT} ft_transfer '{json.dumps(call, separators=(',', ':'))}' \\")
    print(f"    --accountId {args.funder} --depositYocto 1 --networkId mainnet")
    print("then: .venv/bin/python aa_fund.py --wait")


if __name__ == "__main__":
    main()
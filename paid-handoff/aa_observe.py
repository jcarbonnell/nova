#!/usr/bin/env python3
"""
aa_observe.py: step D of the §5.18 observation. One real 0.10 USDC withdrawal from the test agent
to 1000fans.near with memo "listing:test", then reads what actually landed on chain.

Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.grant-token).

    .venv/bin/python aa_observe.py              # quote → confirm → withdraw → poll → read chain
    .venv/bin/python aa_observe.py --probes     # afterwards: two refusal probes (nothing can move)

Answers (§7): 1. who sends the funds and what the withdrawal event names; 2. whether the memo reaches
the chain; 3. whether the exact amount arrives after a dry quote; 6 (part). what an operation proof
holds. Fact 4 (api.sign account) needs `sign.recipients`, which this agent's policy does not have.

Writes ./observation-<timestamp>.json (no secrets). Secrets: API key from ./.env, grant token from
./.grant-token; neither is printed or written.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aa_setup import (  # noqa: E402
    ENV_FILE, GRANT_FILE, MEMO, RECIPIENT, USDC, die, import_asset, load_env, load_state, save_state,
)

AMOUNT = "100000"  # 0.10 USDC
USDC_CONTRACT = USDC.removeprefix("nep141:")
BODY = {"asset": USDC, "amount": AMOUNT, "chain": "near", "recipient": RECIPIENT, "memo": MEMO}
TX_SENDER_CANDIDATES = ["intents.near", "outlayer.near"]


# ------------------------------------------------------------------------------------- chain


def rpc(m, url: str, method: str, params) -> dict:
    return m.httpx.post(url, json={"jsonrpc": "2.0", "id": "o", "method": method, "params": params}, timeout=30).json()


def ft_balance(m, url: str, account: str) -> int:
    args = base64.b64encode(json.dumps({"account_id": account}).encode()).decode()
    r = rpc(m, url, "query", {"request_type": "call_function", "finality": "final", "account_id": USDC_CONTRACT,
                              "method_name": "ft_balance_of", "args_base64": args})
    return int(json.loads(bytes(r["result"]["result"]).decode()))


def fetch_tx(m, url: str, tx_hash: str, senders: list[str]) -> dict | None:
    for sender in senders:
        r = rpc(m, url, "EXPERIMENTAL_tx_status",
                {"tx_hash": tx_hash, "sender_account_id": sender, "wait_until": "FINAL"})
        if "result" in r:
            return r["result"]
    return None


def decode_args(b64: str):
    raw = base64.b64decode(b64)
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        return f"<{len(raw)} bytes, not JSON>"


def summarize_tx(res: dict) -> dict:
    """Signer, every FunctionCall (method + decoded args) and every log line, per receipt."""
    tx = res["transaction"]
    calls = []
    for a in tx.get("actions", []):
        fc = a.get("FunctionCall") if isinstance(a, dict) else None
        if fc:
            calls.append({"receipt": "tx", "receiver": tx["receiver_id"], "method": fc["method_name"],
                          "args": decode_args(fc["args"]), "deposit": fc.get("deposit")})
    for rc in res.get("receipts", []):
        action = (rc.get("receipt") or {}).get("Action") or {}
        for a in action.get("actions", []):
            fc = a.get("FunctionCall") if isinstance(a, dict) else None
            if fc:
                calls.append({"receipt": rc["receipt_id"], "predecessor": rc.get("predecessor_id"),
                              "receiver": rc["receiver_id"], "method": fc["method_name"],
                              "args": decode_args(fc["args"]), "deposit": fc.get("deposit")})
    logs = []
    for ro in res.get("receipts_outcome", []):
        for line in ro["outcome"].get("logs", []):
            entry = {"executor": ro["outcome"]["executor_id"], "log": line}
            if line.startswith("EVENT_JSON:"):
                try:
                    entry["event"] = json.loads(line[len("EVENT_JSON:"):])
                except Exception:  # noqa: BLE001
                    pass
            logs.append(entry)
    status = res.get("status", {})
    return {"signer": tx["signer_id"], "receiver": tx["receiver_id"], "hash": tx["hash"],
            "status": "SuccessValue" if "SuccessValue" in status else status, "calls": calls, "logs": logs}


# ---------------------------------------------------------------------------------------- api


def poll(api, cid: str) -> dict:
    while True:
        st = api.get_status(cid, wait_ms=30_000)
        s = st["status"]
        if s in ("SUCCESS", "REFUNDED", "FAILED"):
            return st
        if s == "NEEDS_REVIEW":
            print(f"✗ NEEDS_REVIEW: {st['details'].get('reason')}. Stop; do not retry. Tell Claude.")
            return st
        print(f"· {s} (dispatch_committed_at={st.get('dispatch_committed_at')}); polling the same id")
        time.sleep(2)


def try_refusal(m, agent, agent_id: str, state: dict, name: str, body: dict) -> dict:
    key = m.create_idempotency_key()
    state.setdefault("probes", {})[name] = {"idempotency_key": key, "body": body}
    save_state(state)
    try:
        st = agent.withdraw(agent_id, body, idempotency_key=key)
        out = {"accepted": True, "correlation_id": st["correlation_id"], "status": st["status"]}
        print(f"! {name}: NOT refused at admission → {st['correlation_id']} {st['status']} (polling)")
        out["final"] = poll(agent, st["correlation_id"])
        return out
    except m.AgentApiError as e:
        print(f"✓ {name}: {e.status} {e.code} (request_id {e.request_id})")
        return {"accepted": False, "status": e.status, "code": e.code, "title": e.title, "detail": e.detail,
                "errors": e.errors, "request_id": e.request_id}


# --------------------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probes", action="store_true", help="refusal probes: wrong memo, over the per-tx cap")
    args = ap.parse_args()

    load_env(ENV_FILE)
    m = import_asset()
    url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
    api = m.AgentApi.from_env()
    state = load_state()
    agent_id = state.get("agent_id") or die("no agent_id; run aa_setup.py")
    if not GRANT_FILE.exists():
        die(f"{GRANT_FILE} missing")
    agent = api.for_grant(GRANT_FILE.read_text().strip())
    record: dict = {"started_at": datetime.now(timezone.utc).isoformat(), "agent_id": agent_id,
                    "api": api.base_url, "body": BODY}

    if args.probes:
        if not (state.get("withdraw") or {}).get("final_status"):
            die("run the observation withdrawal first")
        record["probes"] = {
            "wrong_memo": try_refusal(m, agent, agent_id, state, "wrong_memo", {**BODY, "memo": "listing:99"}),
            "over_cap": try_refusal(m, agent, agent_id, state, "over_cap", {**BODY, "amount": "250000"}),
        }
    else:
        w = state.get("withdraw")
        if w and w.get("final_status"):
            die(f"withdrawal already done ({w['correlation_id']} {w['final_status']}); use --probes next")

        wallet = api.get_agent(agent_id).get("wallet") or {}
        record["agent_near_account_id"] = wallet.get("near_account_id")
        policy = api.get_policy(agent_id)
        if not (policy.get("status") == "APPLIED" and policy.get("provider_policy_synced")):
            die("policy not in force")

        # Demo deployment (its llms.txt): withdrawal previews need a live grant AND an Idempotency-Key;
        # max 20 previews per agent per rolling 24 h. The skills docs say neither is needed.
        dry_key = f"dry-{m.create_idempotency_key()}"
        quote = agent.request("POST", f"/v1/agents/{agent_id}/withdraw", body={**BODY, "dry": True},
                              idempotency_key=dry_key, grant=True)
        record["dry_needed_grant_and_idempotency_key"] = True
        if isinstance(quote, dict) and quote.get("correlation_id") and not quote.get("dry"):
            state["withdraw"] = {"idempotency_key": dry_key, "body": {**BODY, "dry": True},
                                 "correlation_id": quote["correlation_id"], "dry_was_executed": True}
            save_state(state)
            die(f"server EXECUTED the dry request as {quote['correlation_id']}; saved it; do not resend; tell Claude")
        record["quote"] = quote
        print("quote:", json.dumps(quote, indent=2))

        before = ft_balance(m, url, RECIPIENT)
        record["recipient_balance_before"] = before
        print(f"{RECIPIENT} USDC before: {before}")

        if not w:
            print(f"\nabout to withdraw {AMOUNT} (0.10 USDC) to {RECIPIENT} on near, memo {MEMO!r}")
            if input('type "send" to execute: ').strip() != "send":
                die("not sent")
            w = {"idempotency_key": m.create_idempotency_key(), "body": BODY}
            state["withdraw"] = w
            save_state(state)  # key + body persisted BEFORE sending
        else:
            print(f"· resuming saved withdrawal (same idempotency key {w['idempotency_key'][:8]}…)")

        if not w.get("correlation_id"):
            try:
                st = agent.withdraw(agent_id, w["body"], idempotency_key=w["idempotency_key"])
            except m.AgentApiRequestError:
                die("transport error: re-run this script; it resends with the SAME key (safe)")
            w["correlation_id"] = st["correlation_id"]
            save_state(state)
            print(f"· submitted {st['correlation_id']} {st['status']}")

        final = poll(api, w["correlation_id"])
        w["final_status"] = final["status"]
        save_state(state)
        record["status"] = final
        print("final:", json.dumps({k: final.get(k) for k in ("status", "failure_code", "dispatch_committed_at")}),
              json.dumps(final.get("details"), indent=2))

        after = ft_balance(m, url, RECIPIENT)
        record["recipient_balance_after"] = after
        record["recipient_delta"] = after - before
        print(f"{RECIPIENT} USDC after: {after}  delta: {after - before}  (sent {AMOUNT})")

        d = final.get("details") or {}
        senders = [x for x in [d.get("near_account_id"), wallet.get("near_account_id")] if x] + TX_SENDER_CANDIDATES
        for field in ("tx_hash", "destination_tx_hash"):
            h = d.get(field)
            if not h:
                continue
            res = fetch_tx(m, url, h, senders)
            record[f"chain_{field}"] = summarize_tx(res) if res else {"unresolved": h, "tried_senders": senders}
            print(f"\n── {field} {h} ──")
            print(json.dumps(record[f"chain_{field}"], indent=2))

        try:
            record["operation_proof"] = api.request(
                "GET", f"/v1/agents/{agent_id}/operations/{w['correlation_id']}/proof")
        except m.AgentApiError as e:
            record["operation_proof"] = {"error": e.code, "status": e.status}
        try:
            record["provider_requests"] = api.request("GET", f"/v1/agents/{agent_id}/provider/requests",
                                                      query={"limit": 5})
        except m.AgentApiError as e:
            record["provider_requests"] = {"error": e.code, "status": e.status}

    out = Path.cwd() / f"observation-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    out.write_text(json.dumps(record, indent=2, default=str) + "\n")
    print(f"\n✓ wrote {out}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        die("interrupted (state saved; re-run resumes with the same idempotency key)")
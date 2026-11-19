#!/usr/bin/env python3
"""
test-mcp-v049-tx-timeout.py — §5.13 MCP v49: a signed call whose broadcast the RPC
times out on is recovered by polling the SAME tx hash, never by sending again.

Drives the REAL call_contract through the REAL py-near 1.1.59 Account and
JsonProvider (real signing, real error mapping, real send_tx_and_wait). Only the
network is faked: JsonProvider.call_rpc_request answers like a NEAR node, and
server._rpc_tx_call (MCP's own `tx` lookup) reads the same fake chain.

  V1 broadcast times out, the tx landed: the call returns its result; ONE broadcast;
     the lookup names the SIGNING account as sender, waits for FINAL
  V2 the tx landed and failed: the contract's refusal reaches the caller cleanly;
     one broadcast
  V3 the tx becomes known only after two lookups: still recovered
  V4 never found: refused naming the tx hash and "unknown"; one broadcast (no resend)
  V5 no wasted py-near wait: V1 completes in under 5 s
  V6 no timeout: no lookup at all (normal path unchanged)
  V7 a non-timeout broadcast error is not polled: it propagates; one broadcast
  V8 after an InvalidNonce resync, the retry times out: recovered; the rejected
     attempt + one retry = two broadcasts
  V9 no private key material in any log line

Run from mcp-server/ (in the venv: py-near==1.1.59):
    python3 test-mcp-v049-tx-timeout.py
Mutations: mutate-v049.py
"""

import os
import sys
import time
import asyncio
import base64
import hashlib
import importlib.util
import logging
from pathlib import Path

os.environ.setdefault("SESSION_TOKEN_SECRET", "test-session-secret-do-not-use-in-prod")
os.environ.setdefault("SESSION_TOKEN_ISSUER", "https://nova-sdk.com")
os.environ.setdefault("SESSION_TOKEN_AUDIENCE", "https://example.invalid")
os.environ.setdefault("SHADE_API_URL", "http://localhost:3000")
os.environ.setdefault("INTERNAL_API_SECRET", "0" * 64)

import base58  # noqa: E402
from nacl import signing  # noqa: E402
from py_near.account import Account  # noqa: E402

SERVER_PATH = Path(__file__).parent / "server.py"
spec = importlib.util.spec_from_file_location("nova_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
server.SENT_TX_RETRY_SECONDS = 0.01

ACCOUNT = "timeout-test.nova-sdk.near"
CONTRACT = server.get_config(ACCOUNT)["contract_id"]
OK_VALUE = base64.b64encode(b'"ok"').decode()
USER = {"near_account_id": ACCOUNT, "wallet_id": None}


def tx_hash_of(signed_b64: str) -> str:
    raw = base64.b64decode(signed_b64)
    return base58.b58encode(hashlib.sha256(raw[:-65]).digest()).decode()


def tx_nonce_of(signed_b64: str) -> int:
    raw = base64.b64decode(signed_b64)
    n = int.from_bytes(raw[0:4], "little")
    off = 4 + n + 1 + 32
    return int.from_bytes(raw[off:off + 8], "little")


class FakeChain:
    """broadcast: 'ok' | 'timeout' (lands) | 'timeout_lost' (never lands) | 'boom'
    outcome: 'success' | 'failure'; unknown_lookups: NONE lookups answered UNKNOWN first;
    nonce_reject: the first broadcast is rejected with InvalidNonce."""
    def __init__(self, broadcast="ok", outcome="success", unknown_lookups=0, nonce_reject=False):
        self.broadcast, self.outcome, self.unknown = broadcast, outcome, unknown_lookups
        self.nonce_reject = nonce_reject
        self.ak = 100
        self.sent = []          # tx hashes broadcast
        self.landed = {}        # hash -> outcome
        self.lookups = []       # (hash, sender, wait_until)

    def status(self):
        if self.outcome == "failure":
            return {"Failure": {"ActionError": {"index": 0, "kind": {"FunctionCallError": {"ExecutionError": "Smart contract panicked: Unauthorized"}}}}}
        return {"SuccessValue": OK_VALUE}

    async def rpc(self, method, params, broadcast=False, threshold=0):
        if method == "query":
            return {"result": {"nonce": self.ak, "permission": "FullAccess",
                               "block_hash": base58.b58encode(b"\x01" * 32).decode(), "block_height": 1}}
        if method == "broadcast_tx_commit":
            signed = params[0]
            h = tx_hash_of(signed)
            self.sent.append(h)
            if self.nonce_reject and len(self.sent) == 1:
                n = tx_nonce_of(signed); self.ak = n + 3
                return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "INVALID_TRANSACTION"},
                                  "data": {"TxExecutionError": {"InvalidTxError": {"InvalidNonce": {"ak_nonce": self.ak, "tx_nonce": n}}}}}}
            if self.broadcast == "boom":
                return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "INTERNAL_ERROR"}, "data": "injected"}}
            if self.broadcast in ("timeout", "timeout_lost"):
                if self.broadcast == "timeout":
                    self.landed[h] = self.status()
                return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "TIMEOUT_ERROR"}, "data": "routed, not observed"}}
            tx = {"signer_id": ACCOUNT, "public_key": "ed25519:x", "nonce": tx_nonce_of(signed), "receiver_id": CONTRACT,
                  "actions": [], "signature": "ed25519:x", "hash": h}
            outcome = {"id": h, "outcome": {"logs": [], "metadata": {}, "receipt_ids": [], "gas_burnt": 0, "tokens_burnt": "0",
                                            "executor_id": ACCOUNT, "status": {"SuccessValue": ""}}, "block_hash": h, "proof": []}
            return {"result": {"status": self.status(), "transaction": tx, "transaction_outcome": outcome, "receipts_outcome": []}}
        if method == "tx":   # py-near's own wait (must not be reached once v49 is in)
            return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_TRANSACTION"}, "data": "x"}}
        return {"error": {"cause": {"name": "INTERNAL_ERROR"}, "data": f"unexpected {method}"}}

    async def tx_lookup(self, rpc_url, tx_hash, sender_id, wait_until):
        self.lookups.append((tx_hash, sender_id, wait_until))
        if sender_id != ACCOUNT or tx_hash not in self.landed:
            return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_TRANSACTION"}}}
        if wait_until == "NONE" and self.unknown > 0:
            self.unknown -= 1
            return {"error": {"name": "HANDLER_ERROR", "cause": {"name": "UNKNOWN_TRANSACTION"}}}
        if wait_until == "NONE":
            return {"result": {"final_execution_status": "INCLUDED"}}
        return {"result": {"status": self.landed[tx_hash], "transaction": {"hash": tx_hash}}}


CUR = {"chain": None, "key": None}


def new_key():
    sk = signing.SigningKey.generate()
    return "ed25519:" + base58.b58encode(bytes(sk) + bytes(sk.verify_key)).decode()


async def fake_get_user_signer(user):
    acc = Account(user["near_account_id"], CUR["key"], "http://stub.invalid")
    acc._provider.call_rpc_request = CUR["chain"].rpc

    async def status():
        return {"chain_id": "mainnet", "sync_info": {"latest_block_hash": base58.b58encode(b"\x01" * 32).decode(), "latest_block_height": 1}}
    acc._provider.get_status = status
    await acc.startup()
    return acc


async def fake_estimate_fee(action, account_id=None):
    return 0


async def tx_lookup(*a):
    return await CUR["chain"].tx_lookup(*a)

server.get_user_signer = fake_get_user_signer
server._estimate_fee = fake_estimate_fee
server._rpc_tx_call = tx_lookup

captured = []


class _Capture(logging.Handler):
    def emit(self, record):
        captured.append(record.getMessage())


logging.getLogger().addHandler(_Capture())
logging.getLogger().setLevel(logging.INFO)
for name in ("py_near", "httpx"):
    logging.getLogger(name).setLevel(logging.CRITICAL)


def fresh(**kw):
    CUR["chain"] = FakeChain(**kw)
    CUR["key"] = new_key()
    return CUR["chain"]


async def cc():
    return await server.call_contract(user=USER, method_name="get_transactions_for_group",
                                      args={"group_id": "g"}, fee_action="get_transactions_for_group")

results = []


def case(fn):
    try:
        return asyncio.run(fn())
    except Exception as e:
        return False, f"threw {type(e).__name__}: {e}"


def report(name, ok, detail=""):
    tag = name.split()[0]
    print(f"  {'✓' if ok else '✗'} {tag}_ {name[len(tag) + 1:]}" + (f"  → {detail}" if detail and not ok else ""))
    results.append(ok)


print("MCP v49: signed calls after an RPC broadcast timeout")


async def v1():
    c = fresh(broadcast="timeout")
    t0 = time.monotonic()
    r = await cc()
    dt = time.monotonic() - t0
    finals = [x for x in c.lookups if x[2] == "FINAL"]
    ok = (r == '"ok"' and len(c.sent) == 1 and finals and all(s == ACCOUNT and h == c.sent[0] for h, s, _ in c.lookups))
    v1.dt = dt
    return ok, f"r={r!r} sent={len(c.sent)} lookups={c.lookups}"
ok, d = case(v1)
report("V1 broadcast timed out, tx landed: result returned; one broadcast; lookup by the signing account to FINAL", ok, d)


async def v2():
    c = fresh(broadcast="timeout", outcome="failure")
    try:
        await cc()
        return False, "no error"
    except Exception as e:
        return ("Unauthorized" in str(e) and "Transaction" not in str(e) and len(c.sent) == 1), f"{type(e).__name__}: {e}"
ok, d = case(v2)
report("V2 the tx landed and failed: the contract's refusal reaches the caller; one broadcast", ok, d)


async def v3():
    c = fresh(broadcast="timeout", unknown_lookups=2)
    r = await cc()
    return (r == '"ok"' and len(c.sent) == 1 and c.unknown == 0), f"r={r!r} lookups={len(c.lookups)}"
ok, d = case(v3)
report("V3 the tx becomes known only after two lookups: still recovered", ok, d)


async def v4():
    c = fresh(broadcast="timeout_lost")
    try:
        await cc()
        return False, "no error"
    except Exception as e:
        msg = str(e)
        return (c.sent[0] in msg and "unknown" in msg and len(c.sent) == 1
                and len(c.lookups) == server.SENT_TX_ATTEMPTS), f"{msg} sent={len(c.sent)} lookups={len(c.lookups)}"
ok, d = case(v4)
report("V4 never found: refused naming the tx hash and \"unknown\"; one broadcast, no resend", ok, d)

report("V5 no wasted py-near wait: V1 completed in under 5 s", getattr(v1, "dt", 99) < 5, f"{getattr(v1, 'dt', None)} s")


async def v6():
    c = fresh()
    r = await cc()
    return (r == '"ok"' and c.lookups == [] and len(c.sent) == 1), f"lookups={c.lookups}"
ok, d = case(v6)
report("V6 no timeout: no lookup (normal path unchanged)", ok, d)


async def v7():
    c = fresh(broadcast="boom")
    try:
        await cc()
        return False, "no error"
    except Exception as e:
        return (c.lookups == [] and len(c.sent) == 1), f"{type(e).__name__} lookups={c.lookups}"
ok, d = case(v7)
report("V7 a non-timeout broadcast error is not polled: it propagates; one broadcast", ok, d)


async def v8():
    c = fresh(broadcast="timeout", nonce_reject=True)
    r = await cc()
    return (r == '"ok"' and len(c.sent) == 2 and c.lookups and c.lookups[-1][0] == c.sent[1]), f"r={r!r} sent={len(c.sent)}"
ok, d = case(v8)
report("V8 InvalidNonce resync, then the retry times out: recovered; two broadcasts", ok, d)

secret = (CUR["key"] or "x:y").split(":", 1)[1]
leak = [m for m in captured if secret in m or "ed25519:" in m]
report("V9 no private key material in any log line", not leak, f"leaked: {leak[:1]}")

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)

#!/usr/bin/env python3
"""
test-fix-nonce-resync.py — harness for the MCP InvalidNonce resync (§6.1 Piece 4,
gate for S3).

THE BUG: py-near 1.1.59 (pinned) reads an access key's nonce from chain ONCE per
process (class-level Account._access_key_nonce, read only while the entry is 0),
then counts locally. Any OTHER signer for the same key — Shade's access-window
sweep signs as custodial owners — leaves MCP behind for good: every later
call_contract for that user fails InvalidNonce until MCP restarts.

THE FIX: call_contract catches InvalidNonce, resyncs the class-level count to the
chain's ak_nonce (_resync_nonce), and retries ONCE. The tx was rejected before
execution, so a retry cannot double-execute.

Imports the REAL call_contract / _resync_nonce from mcp-server/server.py and drives
them through the REAL py-near 1.1.59 Account (real signing, real nonce cache). Only
the network is faked: a provider that behaves like a NEAR node for one access key
(rejects tx_nonce <= ak_nonce with InvalidNonce, exactly as the chain does).

MUTATION: in call_contract replace the whole
    try:
        result = await _submit()
    except InvalidNonce as e:
        ...
        result = await _submit()
block with
    result = await _submit()  # MUTATION — revert
→ N2, N3, N4, N5, N7 must FAIL (N1, N6, N8 still pass: they don't depend on the retry).

Run from the mcp-server/ directory (needs the MCP venv: py-near==1.1.59):
    cd mcp-server
    python3 ../test-fix-nonce-resync.py
"""

import os
import sys
import asyncio
import base64
import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace

# ── Env must be set BEFORE importing server.py (it reads env at module level) ──
os.environ.setdefault("SESSION_TOKEN_SECRET", "test-session-secret-do-not-use-in-prod")
os.environ.setdefault("SESSION_TOKEN_ISSUER", "https://nova-sdk.com")
os.environ.setdefault("SESSION_TOKEN_AUDIENCE", "https://example.invalid")
os.environ.setdefault("SHADE_API_URL", "http://localhost:3000")
os.environ.setdefault("INTERNAL_API_SECRET", "0" * 64)

import base58  # noqa: E402
from nacl import signing  # noqa: E402
import py_near  # noqa: E402
from py_near.account import Account  # noqa: E402
from py_near.exceptions.provider import InvalidNonce  # noqa: E402

# ── Import the real server.py ─────────────────────────────────────────────────
SERVER_PATH = Path(__file__).parent / "mcp-server" / "server.py"
if not SERVER_PATH.exists():
    SERVER_PATH = Path.cwd() / "server.py"
if not SERVER_PATH.exists():
    print(f"FATAL: cannot find server.py (tried {SERVER_PATH})")
    sys.exit(2)

spec = importlib.util.spec_from_file_location("nova_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

PYNEAR_VERSION = getattr(py_near, "__version__", None)
try:
    from importlib.metadata import version as _v
    PYNEAR_VERSION = PYNEAR_VERSION or _v("py-near")
except Exception:
    pass
print(f"Loaded call_contract from {SERVER_PATH}")
print(f"py-near version: {PYNEAR_VERSION}\n")

if not hasattr(server, "_resync_nonce"):
    print("FATAL: server._resync_nonce not found — is the fix applied?")
    sys.exit(2)

ACCOUNT = "nonce-test.nova-sdk.near"   # mainnet config via get_config (suffix)
OK_VALUE = base64.b64encode(b'"ok"').decode()


# ── Fake NEAR node for one access key ─────────────────────────────────────────
def tx_nonce_of(signed_tx_b64: str) -> int:
    """Borsh Transaction: signer_id (u32 len + bytes), pk (1 + 32), nonce (u64 LE)."""
    raw = base64.b64decode(signed_tx_b64)
    n = int.from_bytes(raw[0:4], "little")
    off = 4 + n + 1 + 32
    return int.from_bytes(raw[off:off + 8], "little")


class FakeNode:
    """
    mode:
      normal  — accept tx_nonce > ak_nonce (then ak = tx_nonce), else InvalidNonce(ak, tx)
      stuck   — every send is rejected; ak jumps ahead each time (retry must NOT loop)
      no_ak   — the FIRST rejection omits ak_nonce; afterwards normal
      boom    — every send raises a non-nonce error (must NOT be retried)
    """
    def __init__(self, chain_nonce, mode="normal"):
        self.chain = chain_nonce
        self.mode = mode
        self.reads = 0
        self.sent = []          # every tx_nonce we were asked to broadcast
        self.accepted = []      # tx_nonces that landed
        self._no_ak_used = False

    # Account.startup / _update_last_block_hash
    async def get_status(self):
        return {
            "chain_id": "mainnet",
            "sync_info": {"latest_block_hash": base58.b58encode(b"\x01" * 32).decode(), "latest_block_height": 1},
        }

    async def get_access_key(self, account_id, public_key, finality="optimistic"):
        self.reads += 1
        return {"block_hash": base58.b58encode(b"\x01" * 32).decode(), "block_height": 1,
                "nonce": self.chain, "permission": "FullAccess"}

    async def send_tx_and_wait(self, signed_tx, trx_hash=None, receiver_id=None):
        n = tx_nonce_of(signed_tx)
        self.sent.append(n)
        if self.mode == "boom":
            raise RuntimeError("injected: RPC unavailable")
        if self.mode == "stuck":
            self.chain = max(self.chain, n) + 5
            raise InvalidNonce({"ak_nonce": self.chain, "tx_nonce": n})
        if n <= self.chain:
            if self.mode == "no_ak" and not self._no_ak_used:
                self._no_ak_used = True
                raise InvalidNonce({"tx_nonce": n})
            raise InvalidNonce({"ak_nonce": self.chain, "tx_nonce": n})
        self.chain = n
        self.accepted.append(n)
        return SimpleNamespace(status={"SuccessValue": OK_VALUE})

    async def shutdown(self):
        pass


# ── Wire server.call_contract to the real py-near Account + fake node ─────────
def new_key():
    sk = signing.SigningKey.generate()
    return "ed25519:" + base58.b58encode(bytes(sk) + bytes(sk.verify_key)).decode()


CURRENT = {"key": None, "node": None}


async def fake_get_user_signer(user):
    acc = Account(user["near_account_id"], CURRENT["key"], "http://stub.invalid")
    acc._provider = CURRENT["node"]
    await acc.startup()
    return acc


async def fake_estimate_fee(action, account_id=None):
    return 0


server.get_user_signer = fake_get_user_signer
server._estimate_fee = fake_estimate_fee

USER = {"near_account_id": ACCOUNT, "wallet_id": None}

captured = []


class _Capture(logging.Handler):
    def emit(self, record):
        captured.append(record.getMessage())


logging.getLogger().addHandler(_Capture())
logging.getLogger().setLevel(logging.INFO)


def fresh(chain_nonce, mode="normal"):
    """New key (fresh class-level cache entry) + new fake node."""
    CURRENT["key"] = new_key()
    CURRENT["node"] = FakeNode(chain_nonce, mode)
    captured.clear()
    return CURRENT["node"]


async def cc():
    return await server.call_contract(user=USER, method_name="revoke_group_member",
                                      args={"group_id": "g", "user_id": "m"}, fee_action="revoke_group_member")


results = []


def case(coro_fn):
    """Run one async case; an uncaught exception is a FAIL, never a crash."""
    try:
        return asyncio.run(coro_fn())
    except Exception as e:
        return False, f"threw {type(e).__name__}: {e}"


def report(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"\n         → {detail}" if detail else ""))
    results.append(ok)


# ── N1: the bug exists in the pinned py-near (raw Account, no MCP code) ───────
async def n1():
    node = fresh(1000)
    acc = await fake_get_user_signer(USER)
    await acc.function_call("nova-sdk.near", "x", {})          # reads chain once → 1001
    node.chain += 2                                              # Shade's sweep signs twice → 1003
    try:
        await acc.function_call("nova-sdk.near", "x", {})      # py-near counts locally → 1002
        return False, f"no error (sent {node.sent})"
    except InvalidNonce as e:
        return (node.reads == 1 and node.sent == [1001, 1002]), \
            f"reads={node.reads} sent={node.sent} ak={getattr(e, 'ak_nonce', None)}"

ok, d = case(n1)
report("N1  pinned py-near reads the nonce ONCE then counts locally → InvalidNonce after an external signer (the bug)", ok, d)


# ── N2: call_contract resyncs to ak_nonce and retries once ───────────────────
async def n2():
    node = fresh(1000)
    r1 = await cc()                    # 1001
    node.chain += 2                    # external signer → 1003
    r2 = await cc()                    # 1002 rejected → resync to 1003 → retry 1004
    logged = any("InvalidNonce" in m and "resynced" in m for m in captured)
    ok = (r1 == '"ok"' and r2 == '"ok"' and node.sent == [1001, 1002, 1004]
          and node.accepted == [1001, 1004] and logged)
    return ok, f"sent={node.sent} accepted={node.accepted} warning_logged={logged}"

ok, d = case(n2)
report("N2  desynced call: InvalidNonce → resync to ak_nonce → ONE retry with ak+1 succeeds", ok, d)


# ── N3: after a resync, local counting continues — no extra chain reads ──────
async def n3():
    node = fresh(2000)
    await cc()                         # 2001 (1 read)
    node.chain += 1                    # → 2002
    await cc()                         # 2002 rejected → retry 2003
    reads_before = node.reads
    await cc()                         # 2004, no read
    return (node.accepted == [2001, 2003, 2004] and node.reads == reads_before == 1), \
        f"accepted={node.accepted} reads={node.reads}"

ok, d = case(n3)
report("N3  after a resync the next call just counts on (no extra chain read)", ok, d)


# ── N4: exactly ONE retry — a second InvalidNonce reaches the caller ─────────
async def n4():
    node = fresh(3000, mode="stuck")
    try:
        await cc()
        return False, f"no error (sent {node.sent})"
    except InvalidNonce:
        return len(node.sent) == 2, f"sent={node.sent} (expected exactly 2 attempts)"

ok, d = case(n4)
report("N4  exactly one retry: a second InvalidNonce propagates (no loop)", ok, d)


# ── N5: InvalidNonce WITHOUT ak_nonce → cache reset → retry re-reads chain ───
async def n5():
    node = fresh(4000, mode="no_ak")
    await cc()                         # 4001
    node.chain += 3                    # → 4004
    reads_before = node.reads          # 1
    r = await cc()                     # 4002 rejected (no ak) → reset → re-read 4004 → 4005
    return (r == '"ok"' and node.reads == reads_before + 1 and node.accepted == [4001, 4005]), \
        f"reads {reads_before}→{node.reads} sent={node.sent} accepted={node.accepted}"

ok, d = case(n5)
report("N5  InvalidNonce without ak_nonce → forces a fresh chain read on the retry", ok, d)


# ── N6: only InvalidNonce is retried — other errors propagate, one attempt ──
async def n6():
    node = fresh(5000, mode="boom")
    try:
        await cc()
        return False, "no error"
    except InvalidNonce:
        return False, "boom surfaced as InvalidNonce?"
    except Exception as e:
        return len(node.sent) == 1, f"sent={node.sent} error={type(e).__name__}"

ok, d = case(n6)
report("N6  non-nonce errors are NOT retried (single attempt, error propagates)", ok, d)


# ── N7: two CONCURRENT desynced calls for the same user both land, distinct ──
async def n7():
    node = fresh(6000)
    await cc()                         # 6001
    node.chain += 4                    # external signer → 6005
    r = await asyncio.gather(cc(), cc(), return_exceptions=True)
    ok = (all(x == '"ok"' for x in r) and len(set(node.accepted)) == len(node.accepted)
          and node.accepted == sorted(node.accepted) and len(node.accepted) == 3)
    return ok, f"results={r} accepted={node.accepted}"

ok, d = case(n7)
report("N7  two concurrent desynced calls both land with distinct nonces", ok, d)


# ── N8: the resync path never logs key material ──────────────────────────────
leak = [m for m in captured if "ed25519:" in m or CURRENT["key"].split(":", 1)[1] in m]
report("N8  no private key material in any captured log message", not leak, f"leaked: {leak[:1]}" if leak else "")


print("\n" + "=" * 66)
if all(results):
    print(f"ALL {len(results)} TESTS PASSED — MCP self-heals after an external signer.")
    sys.exit(0)
else:
    print(f"{results.count(False)}/{len(results)} FAILED — DO NOT DEPLOY.")
    sys.exit(1)
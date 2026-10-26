#!/usr/bin/env python3
"""
test-fix-access-windows-mcp.py — harness for §6.1 Piece 4 S4 (MCP access windows).

Imports the REAL add_group_member / revoke_group_member / get_member_window from
mcp-server/server.py and drives them with fakes for the three effects they use:
  _shade_internal  (Shade's gated access-window routes + rotate_key)
  view_contract    (is_authorized / get_group_owner, free views)
  call_contract    (the owner-signed on-chain call)
Every call is recorded IN ORDER, so the ordering guarantees are asserted directly.

PROVES:
  A1  new member + window: window recorded FIRST, then the on-chain add.
  A2  new member + window: a failed window write ABORTS — no on-chain add.
  A3  new member, no window: old window cleared FIRST, then the add.
  A4  new member, no window: a failed clear ABORTS — no on-chain add.
  A5  wallet/agent session + window: refused before ANY Shade or chain call.
  A6  invalid access_minutes (0, 525601, True, "60", 1.5) refused before any call.
  A7  already a member + window: window set/extended, NO on-chain add.
  A8  already a member, no window: contract panic surfaces, window NOT touched.
  A9  add fails after the window was set: best-effort clear, error re-raised.
  A10 add fails "already a member" (race): window KEPT (it applies to the member).
  A11 membership check fails (RPC): nothing written, nothing signed.
  R1  revoke: on-chain revoke → rotate → window clear (in that order).
  R2  revoke: a failed window clear does NOT fail the revoke.
  G1  get_member_window: owner gets the window.
  G2  get_member_window: non-owner refused, Shade never asked.
  G3  get_member_window: wallet/agent session refused, nothing asked.

MUTATIONS (edit server.py, rerun, revert). Each must fail its named check(s):
  M1 order    in add_group_member, CUT the block from `    try:` /
              `        await call_contract(` down to its `        raise` line, and
              PASTE it just above `    try:` / `        already_member = ...`
              (on-chain add before any window bookkeeping)       → A1–A4, A7, A9–A11
  M2 abort    in the set branch, replace `raise RuntimeError(` (the
              "Access-window write failed" one) with `logger.warning(`      → A2
  M3 wallet   delete the `if not has_custodial_key(user): raise PermissionError(
              "Access windows need ...")` block in add_group_member          → A5
  M4 owner    in get_member_window, replace
              `if owner != user["near_account_id"]:` with `if False:`         → G2

Run from the mcp-server/ directory (MCP venv):
    cd mcp-server
    python3 ../test-fix-access-windows-mcp.py
"""

import os
import sys
import asyncio
import importlib.util
from pathlib import Path

os.environ.setdefault("SESSION_TOKEN_SECRET", "test-session-secret-do-not-use-in-prod")
os.environ.setdefault("SESSION_TOKEN_ISSUER", "https://nova-sdk.com")
os.environ.setdefault("SESSION_TOKEN_AUDIENCE", "https://example.invalid")
os.environ.setdefault("SHADE_API_URL", "http://localhost:3000")
os.environ.setdefault("INTERNAL_API_SECRET", "0" * 64)

SERVER_PATH = Path(__file__).parent / "mcp-server" / "server.py"
if not SERVER_PATH.exists():
    SERVER_PATH = Path.cwd() / "server.py"
if not SERVER_PATH.exists():
    print(f"FATAL: cannot find server.py (tried {SERVER_PATH})")
    sys.exit(2)

spec = importlib.util.spec_from_file_location("nova_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
print(f"Loaded server.py from {SERVER_PATH}\n")

for name in ("_shade_internal", "get_member_window"):
    if not hasattr(server, name):
        print(f"FATAL: server.{name} not found — are the S4 edits applied?")
        sys.exit(2)

OWNER = "owner.nova-sdk.near"
OTHER = "someone-else.nova-sdk.near"
MEMBER = "buyer.nova-sdk.near"
GROUP = "capsule-1"
CONTRACT = "nova-sdk.near"

CUSTODIAL = {"near_account_id": OWNER, "wallet_id": None, "email": None}
WALLET = {"near_account_id": OWNER, "wallet_id": OWNER, "email": None}


def inner(fn):
    return getattr(fn, "__inner__", fn)


class FakeResp:
    def __init__(self, status, body=None):
        self.status_code = status
        self._body = body or {}
        self.text = str(self._body)

    def json(self):
        return self._body


class World:
    def __init__(self, member=False, owner=OWNER, shade=None, chain=None, view_fail=False):
        self.calls = []
        self.member = member
        self.owner = owner
        self.shade = shade or {}        # path -> status code (default 200)
        self.chain = chain              # None = ok, else Exception to raise
        self.view_fail = view_fail
        self.window = {"expires_at": "2026-10-26T11:00:00.000Z", "expires_at_ms": 1, "set_at": "x"}

    async def shade_internal(self, path, body, timeout=15.0):
        self.calls.append(("shade", path, dict(body)))
        status = self.shade.get(path, 200)
        if isinstance(status, Exception):
            raise status
        if path.endswith("/set"):
            return FakeResp(status, {"set": True, "expires_at": "2026-10-26T11:00:00.000Z"})
        if path.endswith("/get"):
            return FakeResp(status, {"window": self.window})
        return FakeResp(status, {"cleared": True, "was_present": False})

    async def view_contract(self, user, method, args):
        self.calls.append(("view", method))
        if self.view_fail:
            raise RuntimeError("RPC error: timeout")
        if method == "is_authorized":
            return self.member
        if method == "get_group_owner":
            return self.owner
        raise AssertionError(f"unexpected view {method}")

    async def call_contract(self, user, method_name, args, fee_action, **kw):
        self.calls.append(("chain", method_name))
        if self.chain:
            raise self.chain
        return "ok"

    def install(self):
        server._shade_internal = self.shade_internal
        server.view_contract = self.view_contract
        server.call_contract = self.call_contract

    def kinds(self):
        return [c[0] if c[0] != "shade" else f"shade:{c[1].rsplit('/', 1)[-1]}" for c in self.calls
                if c[0] != "view"]


# rotate_key in revoke_group_member uses httpx directly; stub the client for R1/R2.
class FakeClient:
    def __init__(self, world):
        self.w = world

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None):
        self.w.calls.append(("shade", url.replace(os.environ["SHADE_API_URL"], ""), dict(json or {})))
        return FakeResp(200, {"success": True})


results = []


def run(name, coro_fn, world):
    world.install()
    try:
        ok, detail = asyncio.run(coro_fn(world))
    except Exception as e:
        ok, detail = False, f"threw {type(e).__name__}: {e}"
    print(f"[{'PASS' if ok else 'FAIL'}] {name}\n         → {detail}")
    results.append(ok)


add = inner(server.add_group_member)
revoke = inner(server.revoke_group_member)
getw = inner(server.get_member_window)


async def raises(coro):
    try:
        await coro
        return None
    except Exception as e:
        return e


# ── add_group_member ─────────────────────────────────────────────────────────
async def a1(w):
    r = await add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=60)
    k = w.kinds()
    set_body = next(c[2] for c in w.calls if c[0] == "shade" and c[1].endswith("/set"))
    return (k == ["shade:set", "chain"] and set_body["access_minutes"] == 60
            and set_body["contract_id"] == CONTRACT and "with access until" in r), f"calls={k}"

run("A1  new member + window: window recorded FIRST, then the on-chain add", a1, World())


async def a2(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=60))
    k = w.kinds()
    return (e is not None and "chain" not in k), f"calls={k} error={e}"

run("A2  new member + window: failed window write ABORTS (no on-chain add)", a2,
    World(shade={"/rpc/access-windows/set": 500}))


async def a3(w):
    await add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER)
    k = w.kinds()
    return k == ["shade:clear", "chain"], f"calls={k}"

run("A3  new member, no window: old window cleared FIRST, then the add", a3, World())


async def a4(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER))
    k = w.kinds()
    return (e is not None and "chain" not in k), f"calls={k} error={e}"

run("A4  new member, no window: failed clear ABORTS (no on-chain add)", a4,
    World(shade={"/rpc/access-windows/clear": 503}))


async def a5(w):
    e = await raises(add(None, WALLET, group_id=GROUP, member_id=MEMBER, access_minutes=60))
    return (isinstance(e, PermissionError) and w.calls == []), f"calls={w.calls} error={e}"

run("A5  wallet/agent session + window: refused before ANY Shade or chain call", a5, World())


async def a6(w):
    bad = [0, 525_601, True, "60", 1.5, -5]
    outcomes = []
    for v in bad:
        e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=v))
        outcomes.append(isinstance(e, ValueError))
    return (all(outcomes) and w.calls == []), f"refused={outcomes} calls={w.calls}"

run("A6  invalid access_minutes refused before any call", a6, World())


async def a7(w):
    r = await add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=30)
    k = w.kinds()
    return (k == ["shade:set"] and "already a member" in r), f"calls={k} result={r!r}"

run("A7  already a member + window: window set/extended, NO on-chain add", a7, World(member=True))


async def a8(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER))
    k = w.kinds()
    return (e is not None and "already a member" in str(e).lower()
            and not any(x.startswith("shade") for x in k)), f"calls={k} error={e}"

run("A8  already a member, no window: panic surfaces, window NOT touched", a8,
    World(member=True, chain=RuntimeError("Smart contract panicked: User already a member")))


async def a9(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=60))
    k = w.kinds()
    return (e is not None and k == ["shade:set", "chain", "shade:clear"]), f"calls={k} error={e}"

run("A9  add fails after the window was set: best-effort clear, error re-raised", a9,
    World(chain=RuntimeError("Smart contract panicked: Group not found")))


async def a10(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=60))
    k = w.kinds()
    return (e is not None and k == ["shade:set", "chain"]), f"calls={k}"

run("A10 add races to 'already a member': window KEPT (applies to the member)", a10,
    World(chain=RuntimeError("Smart contract panicked: User already a member")))


async def a11(w):
    e = await raises(add(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER, access_minutes=60))
    return (e is not None and w.kinds() == []), f"calls={w.kinds()} error={e}"

run("A11 membership check fails (RPC): nothing written, nothing signed", a11, World(view_fail=True))


# ── revoke_group_member ──────────────────────────────────────────────────────
def with_fake_httpx(world, fn):
    async def wrapped(w):
        real = server.httpx.AsyncClient
        server.httpx.AsyncClient = lambda *a, **k: FakeClient(w)
        try:
            return await fn(w)
        finally:
            server.httpx.AsyncClient = real
    return wrapped


async def r1(w):
    await revoke(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER)
    k = w.kinds()
    return k == ["chain", "shade:rotate_key", "shade:clear"], f"calls={k}"

run("R1  revoke: on-chain revoke → rotate → window clear (in order)", with_fake_httpx(None, r1), World())


async def r2(w):
    r = await revoke(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER)
    return ("Revoked" in r and w.kinds()[-1] == "shade:clear"), f"result={r!r}"

run("R2  revoke: a failed window clear does NOT fail the revoke", with_fake_httpx(None, r2),
    World(shade={"/rpc/access-windows/clear": ConnectionError("shade down")}))


# ── get_member_window ────────────────────────────────────────────────────────
async def g1(w):
    r = await getw(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER)
    return (r.get("window", {}).get("expires_at") == w.window["expires_at"]
            and w.kinds() == ["shade:get"]), f"result={r}"

run("G1  get_member_window: owner gets the window", g1, World())


async def g2(w):
    e = await raises(getw(None, CUSTODIAL, group_id=GROUP, member_id=MEMBER))
    return (isinstance(e, PermissionError) and w.kinds() == []), f"calls={w.kinds()} error={e}"

run("G2  get_member_window: non-owner refused, Shade never asked", g2, World(owner=OTHER))


async def g3(w):
    e = await raises(getw(None, WALLET, group_id=GROUP, member_id=MEMBER))
    return (isinstance(e, PermissionError) and w.calls == []), f"calls={w.calls} error={e}"

run("G3  get_member_window: wallet/agent session refused, nothing asked", g3, World())


print("\n" + "=" * 66)
if all(results):
    print(f"ALL {len(results)} TESTS PASSED — windows are recorded before access is granted.")
    sys.exit(0)
else:
    print(f"{results.count(False)}/{len(results)} FAILED — DO NOT DEPLOY.")
    sys.exit(1)

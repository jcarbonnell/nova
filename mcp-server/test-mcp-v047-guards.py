# mcp-server/test-mcp-v047-guards.py
#
# HARNESS-FIRST (§10) for MCP v47, offline. Imports the REAL server.py and the
# REAL guards.py, and stubs only the network seams (_view_account, the reader
# signer). Throwaway environment values only; no .env is read.
#
#   F — 6a free-balance floor (guards.FreeBalanceFloor, wired into read_owner_gated_view):
#     F1 available below the floor → refused (503, "below the safety floor"), and NOTHING is signed
#     F2 available exactly at the floor → allowed; the reader signs once and its result is returned
#     F3 available = amount − storage_usage × 10^19 (storage-locked NEAR is not "free")
#     F4 balance read fails → refused (503, "balance check … failed"), nothing signed, failure not cached
#     F5 a successful read is cached for 60 s (two views → one read); after 60 s it is read again
#     F6 the floor is checked against nova-sdk.near (READER_ACCOUNT_ID), never the session account
#
#   R — 6b rate limit on signed reader views (guards.RateLimiter, wired into read_owner_gated_view):
#     R1 10 views in a minute pass; the 11th is refused (429) and NOT signed
#     R2 the limit is per session account: another account is still served
#     R3 the window slides: 60 s after the first view, a new one passes
#     R4 a rate refusal costs no RPC (checked before the balance read)
#
#   K — 6b API-key verification cache (guards.VerifiedKeyCache, wired into _user_from_api_key):
#     K1 a verified key: the second auth within 60 s does not call Shade
#     K2 after 60 s, Shade is called again
#     K3 a refused key is never cached: each attempt calls Shade and is refused
#     K4 keyed by key AND account: the same key for another account calls Shade
#     K5 the raw key is never stored, only its hash
#
#   C — 6c clean contract errors (guards.contract_failure, wired into both Failure sites):
#     C1 "Unauthorized: not a member" (real NEAR failure shape) → 403, the contract's sentence only
#     C2 "Group not found" → 404;  C3 "Join window full" → 409;  C4 "Invalid group_id: …" → 400
#     C5 a failure that is not a contract panic → 502, no raw details
#     C6 read_owner_gated_view: a refusal surfaces as ContractRefusal 403 (still a RuntimeError)
#     C7 call_contract: same
#
#   H — 6c HTTP statuses through a REAL expose_as_rest route (Starlette test client):
#     H1 PermissionError → 403;  H2 ValueError → 400;  H3 GuardRefusal(429) → 429;
#     H4 contract refusal (409) → 409;  H5 any other exception → 500;  H6 /health reports 0.4.13
#
# MUTATIONS (each must turn the named checks ❌):
#   M1 delete `await READER_FLOOR.require(READER_ACCOUNT_ID)` in server.py   → F1, F3, F4, F5, F6
#   M2 guards.available ignores storage (avail = amount)                      → F1, F3
#   M3 guards caches nothing (drop the cache lookup)                          → F5
#   M4 guards swallows read errors as "available = 10^30"                     → F4
#   M5 delete `READER_RATE.hit(account_id)` in server.py                     → R1, R2, R3
#   M6 the limiter keys on a constant instead of the account                  → R2, R3
#   M7 _user_from_api_key remembers the key BEFORE checking Shade's answer    → K3
#   M8 the cache id ignores the account                                       → K4
#   M9 the cache stores the raw key instead of its hash                       → K5
#   M10 expose_as_rest returns 500 for every exception (rest_status unused)   → H1–H4
#   M11 contract_failure keeps the raw failure text                           → C1–C4, C6, C7, H4
#   M12 "Unauthorized…" / "Only …" not classified as 403                      → C1, C6, C7
#   M13 call_contract still raises RuntimeError(raw failure)                  → C7
#
# RUN (from mcp-server/):  python3 test-mcp-v047-guards.py [path/to/server.py]
import asyncio, base64, importlib.util, json, os, sys

os.environ.setdefault("SESSION_TOKEN_SECRET", "x" * 32)
os.environ.setdefault("SHADE_API_URL", "https://shade.invalid")
os.environ.setdefault("INTERNAL_API_SECRET", "internal")
os.environ.setdefault("READER_PRIVATE_KEY", "ed25519:stub")
os.environ.pop("FASTNEAR_API_KEY", None)

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "server.py")
spec = importlib.util.spec_from_file_location("server_under_test", path)
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
import guards as G

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print(f"  ✅ {name}")
    else: failed += 1; print(f"  ❌ {name}")

NEAR = 10**24
FLOOR = G.FREE_BALANCE_FLOOR_YOCTO
STORAGE = 573_300                       # bytes, like nova-sdk.near today
LOCKED = STORAGE * G.STORAGE_YOCTO_PER_BYTE

state = {"amount": LOCKED + FLOOR, "fail": False}
reads, signed = [], []
async def fake_view_account(account_id):
    reads.append(account_id)
    if state["fail"]:
        raise RuntimeError("fake RPC outage")
    return {"amount": str(state["amount"]), "storage_usage": STORAGE}

class FakeReaderAcc:
    async def function_call(self, contract_id, method_name, args, amount, gas):
        signed.append((contract_id, method_name, args))
        class Res: pass
        r = Res(); r.status = {"SuccessValue": base64.b64encode(json.dumps(["g1"]).encode()).decode()}
        return r
async def fake_reader_signer(): return FakeReaderAcc()

S._view_account = fake_view_account
S.get_reader_signer = fake_reader_signer

clock = {"t": 1000.0}
def fresh_floor():
    # a fresh floor (empty cache) with a controllable clock, wired the same way as server.py's
    S.READER_FLOOR = G.FreeBalanceFloor(fetch_account=lambda a: S._view_account(a), clock=lambda: clock["t"])

def reset(amount=None, fail=False):
    reads.clear(); signed.clear(); state["fail"] = fail
    if amount is not None: state["amount"] = amount
    fresh_floor()
    S.READER_RATE = G.RateLimiter(clock=lambda: clock["t"])
    S.API_KEY_CACHE = G.VerifiedKeyCache(clock=lambda: clock["t"])

KEY = "nova_sk_" + "k" * 40
verify_calls = []
verify_answer = {"status": 200, "valid": True}
async def fake_verify(api_key, account_id):
    verify_calls.append(account_id)
    return verify_answer["status"], {"valid": verify_answer["valid"], "account_id": account_id}
S._shade_verify_api_key = fake_verify

async def auth_fails(api_key, account):
    try:
        await S._user_from_api_key(api_key, account)
        return False
    except ValueError as e:
        return "Auth failed" in str(e)

async def refused(coro, needle):
    try:
        await coro
        return False
    except G.GuardRefusal as e:
        return e.status == 503 and needle in str(e)

async def main():
    print("\nF — 6a free-balance floor:")
    reset(amount=LOCKED + FLOOR - 1)
    ok = await refused(S.read_owner_gated_view("get_owned_groups_of", "alice.near"), "below the safety floor")
    check("F1 1 yocto below the floor → refused 503, nothing signed", ok and not signed)

    reset(amount=LOCKED + FLOOR)
    r = await S.read_owner_gated_view("get_owned_groups_of", "alice.near")
    check("F2 exactly at the floor → allowed, the reader signs once, result returned",
          r == ["g1"] and len(signed) == 1 and signed[0][1] == "get_owned_groups_of")

    total = LOCKED + 4 * 10**23           # 6.13 NEAR total, 0.4 NEAR available
    reset(amount=total)
    ok = await refused(S.read_owner_gated_view("get_owned_groups_of", "alice.near"), "below the safety floor")
    check("F3 storage-locked NEAR is not free: 6.13 NEAR total, 0.4 available → refused",
          total > 12 * FLOOR and ok and not signed)

    reset(fail=True)
    ok = await refused(S.read_owner_gated_view("get_owned_groups_of", "alice.near"), "balance check for")
    ok2 = await refused(S.read_owner_gated_view("get_owned_groups_of", "alice.near"), "balance check for")
    check("F4 balance read fails → refused 503, nothing signed, failure not cached (read again)",
          ok and ok2 and not signed and len(reads) == 2)

    reset(amount=LOCKED + FLOOR + NEAR)
    await S.read_owner_gated_view("get_owned_groups_of", "alice.near")
    await S.read_owner_gated_view("get_member_groups_of", "alice.near")
    first = len(reads)
    clock["t"] += 61
    await S.read_owner_gated_view("get_owned_groups_of", "alice.near")
    check("F5 cached for 60 s (two views → one read), read again after 61 s",
          first == 1 and len(reads) == 2 and len(signed) == 3)

    check("F6 the floor reads nova-sdk.near (READER_ACCOUNT_ID), never the session account",
          set(reads) == {S.READER_ACCOUNT_ID} and "alice.near" not in reads)

    print("\nR — 6b rate limit on signed reader views:")
    reset(amount=LOCKED + FLOOR + NEAR)
    for _ in range(10):
        await S.read_owner_gated_view("get_owned_groups_of", "bob.near")
    n_signed, n_reads = len(signed), len(reads)
    ok = await refused429(S.read_owner_gated_view("get_owned_groups_of", "bob.near"))
    check("R1 10 views in a minute pass; the 11th is refused 429 and not signed", n_signed == 10 and ok and len(signed) == 10)
    check("R4 … and the refusal made no balance read", len(reads) == n_reads)
    ok = await served(S.read_owner_gated_view("get_owned_groups_of", "carol.near"))
    check("R2 the limit is per account: carol is still served", ok and len(signed) == 11)
    clock["t"] += 60
    ok = await served(S.read_owner_gated_view("get_owned_groups_of", "bob.near"))
    check("R3 the window slides: 60 s later bob is served again", ok and len(signed) == 12)

    print("\nK — 6b API-key verification cache:")
    reset(); verify_calls.clear(); verify_answer.update(status=200, valid=True)
    u1 = await S._user_from_api_key(KEY, "dave.near")
    u2 = await S._user_from_api_key(KEY, "dave.near")
    check("K1 verified key: the second auth within 60 s does not call Shade",
          len(verify_calls) == 1 and u1["near_account_id"] == u2["near_account_id"] == "dave.near"
          and u2["auth_method"] == "api_key")
    clock["t"] += 60
    await S._user_from_api_key(KEY, "dave.near")
    check("K2 after 60 s, Shade is called again", len(verify_calls) == 2)

    reset(); verify_calls.clear(); verify_answer.update(status=200, valid=False)
    r1 = await auth_fails(KEY, "erin.near"); r2 = await auth_fails(KEY, "erin.near")
    check("K3 a refused key is never cached: each attempt calls Shade and is refused",
          r1 and r2 and len(verify_calls) == 2)

    reset(); verify_calls.clear(); verify_answer.update(status=200, valid=True)
    await S._user_from_api_key(KEY, "dave.near")
    await S._user_from_api_key(KEY, "frank.near")
    check("K4 keyed by key AND account: another account calls Shade again", verify_calls == ["dave.near", "frank.near"])
    check("K5 the raw key is never stored, only its hash",
          KEY not in repr(S.API_KEY_CACHE.__dict__) and "k" * 40 not in repr(S.API_KEY_CACHE.__dict__))

def near_failure(msg):
    # the shape NEAR returns for a contract panic
    return {"ActionError": {"index": 0, "kind": {"FunctionCallError": {"ExecutionError": f"Smart contract panicked: {msg}"}}}}

class FailingAcc:
    def __init__(self, failure): self.failure = failure
    async def function_call(self, **kw):
        class Res: pass
        r = Res(); r.status = {"Failure": self.failure}
        return r

async def raises(coro):
    try:
        await coro
        return None
    except Exception as e:
        return e

async def served(coro):
    try:
        await coro
        return True
    except G.GuardRefusal:
        return False

async def main_c_h():
    print("\nC — 6c clean contract errors:")
    e = G.contract_failure(near_failure("Unauthorized: not a member"))
    check("C1 'Unauthorized: not a member' → 403 with only the contract's sentence",
          isinstance(e, G.ContractRefusal) and e.status == 403 and str(e) == "Unauthorized: not a member")
    e2, e3, e4 = (G.contract_failure(near_failure(m)) for m in
                  ("Group not found", "Join window full", "Invalid group_id: use 1-64 characters from [A-Za-z0-9._-]"))
    check("C2–C4 Group not found → 404, Join window full → 409, Invalid group_id → 400",
          (e2.status, e3.status, e4.status) == (404, 409, 400) and str(e3) == "Join window full")
    raw = {"ActionError": {"index": 0, "kind": {"AccountDoesNotExist": {"account_id": "secret-detail.near"}}}}
    e5 = G.contract_failure(raw)
    check("C5 a non-panic failure → 502, no raw details", e5.status == 502 and "secret-detail" not in str(e5))

    reset(amount=LOCKED + FLOOR + NEAR)
    S.get_reader_signer = lambda: _acc(FailingAcc(near_failure("Unauthorized: not a member")))
    err = await raises(S.read_owner_gated_view("get_owned_groups_of", "gina.near"))
    S.get_reader_signer = fake_reader_signer
    check("C6 read_owner_gated_view: refusal → ContractRefusal 403, clean, still a RuntimeError",
          isinstance(err, G.ContractRefusal) and isinstance(err, RuntimeError) and err.status == 403
          and str(err) == "Unauthorized: not a member")

    saved = (S.get_user_signer, S._estimate_fee)
    S.get_user_signer = lambda user: _acc(FailingAcc(near_failure("Only group owner or contract owner can tombstone")))
    async def no_fee(action, account_id=None): return 0
    S._estimate_fee = no_fee
    err = await raises(S.call_contract({"near_account_id": "gina.nova-sdk.near"}, "tombstone_transactions", {}, "none"))
    S.get_user_signer, S._estimate_fee = saved
    check("C7 call_contract: refusal → ContractRefusal 403, clean",
          isinstance(err, G.ContractRefusal) and err.status == 403
          and str(err) == "Only group owner or contract owner can tombstone")

    print("\nH — 6c HTTP statuses through a real expose_as_rest route:")
    from starlette.testclient import TestClient
    async def fake_resolve(ctx=None, request=None): return {"near_account_id": "hank.near"}
    saved_resolve = S.resolve_user
    S.resolve_user = fake_resolve
    @S.expose_as_rest("/__v047_probe")
    async def v047_probe(ctx, user, kind: str = ""):
        if kind == "perm": raise PermissionError("Only the group owner can read access windows")
        if kind == "value": raise ValueError("Invalid or expired upload_id")
        if kind == "rate": raise G.GuardRefusal(429, "too many signed views")
        if kind == "contract": raise G.contract_failure(near_failure("Already a member"))
        raise RuntimeError("unexpected")
    client = TestClient(S.mcp.http_app())
    got = {k: client.post("/__v047_probe", json={"kind": k}) for k in ("perm", "value", "rate", "contract", "other")}
    S.resolve_user = saved_resolve
    check("H1 PermissionError → 403", got["perm"].status_code == 403)
    check("H2 ValueError → 400", got["value"].status_code == 400)
    check("H3 GuardRefusal(429) → 429", got["rate"].status_code == 429)
    check("H4 contract refusal → 409 with the contract's sentence",
          got["contract"].status_code == 409 and got["contract"].json() == {"error": "Already a member"})
    check("H5 any other exception → 500", got["other"].status_code == 500)
    src = open(path, encoding="utf-8").read()
    check("H6 /health and the startup log report 0.4.13",
          '"version": "0.4.13"' in src and "NOVA MCP Server v0.4.13" in src and "0.4.12 starting" not in src)

async def _acc(a): return a

async def refused429(coro):
    try:
        await coro
        return False
    except G.GuardRefusal as e:
        return e.status == 429 and "too many signed views" in str(e)

asyncio.run(main())
asyncio.run(main_c_h())
print(f"\n{'─'*60}\n  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

# test-d2a-wallet-writes.py
# Deliverable 2 (A) — standalone harness for MCP's wallet-signed write paths.
# No network, no Shade, no chain: contract views, RPC tx lookup and Shade HTTP
# are stubbed; the REAL tool functions from server.py run.
#
#   python3 test-d2a-wallet-writes.py            (from the mcp-server dir)
#   python3 test-d2a-wallet-writes.py path/to/server.py
#
# Invariants proven:
#   W*  wallet sessions: MCP never signs (call_contract / get_user_signer never
#       reached); every side effect is gated on on-chain owner/membership; an
#       upload is written only after its exact record tx is verified on chain.
#   C*  custodial sessions: unchanged behaviour (signs as before, no tx_hash).
import asyncio
import base64
import importlib.util
import json
import os
import sys
import traceback

# Test env only — never the production .env.
os.environ.update({
    "SHADE_API_URL": "http://shade.test",
    "INTERNAL_API_SECRET": "harness-internal",
    "SESSION_TOKEN_SECRET": "harness-secret",
    "FASTNEAR_API_KEY": "",
})

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")
spec = importlib.util.spec_from_file_location("nova_server", path)
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)

CONTRACT = S.CONFIG["mainnet"]["contract_id"]
ALICE = "alice.near"
MALLORY = "mallory.near"
BOB = "bob.near"
GROUP = "g-wallet"
LOCATION = f"{CONTRACT}/fastfs.near/{GROUP}/file-1"
FILE_HASH = "ab" * 32
TX = "8" * 44


def wallet_user(acc=ALICE):
    return {"email": None, "wallet_id": acc, "near_account_id": acc,
            "access_token": "t", "session_token": "s"}

def apikey_wallet_user(acc=ALICE):
    # A wallet account signed in with an API key: sub 'apikey|…' → no wallet_id.
    return {"email": None, "wallet_id": None, "near_account_id": acc,
            "access_token": None, "session_token": "s", "auth_method": "api_key"}

def custodial_user(acc="carol.nova-sdk.near"):
    return {"email": None, "wallet_id": None, "near_account_id": acc,
            "access_token": None, "session_token": "s", "auth_method": "api_key"}


# ── stubs ────────────────────────────────────────────────────────────────────
class State:
    def reset(self):
        self.owner = ALICE           # get_group_owner
        self.owner_after = 0         # owner only visible after N polls (settle)
        self.polls = 0
        self.members = {BOB: True}   # is_authorized
        self.shade = []              # (path, json)
        self.shade_status = {}       # path -> status code
        self.shade_body = {}         # path -> json body
        self.signed = []             # call_contract calls
        self.tx = None               # RPC tx result
        self.tx_lookups = 0

ST = State()


async def fake_view(user, method, args):
    if method == "get_group_owner":
        ST.polls += 1
        return ST.owner if ST.polls > ST.owner_after else None
    if method == "is_authorized":
        return ST.members.get(args["user_id"], False)
    raise AssertionError(f"unexpected view {method}")


async def fake_call_contract(user, method_name, args, fee_action, **kw):
    ST.signed.append((user["near_account_id"], method_name, args))
    if method_name == "record_transaction":
        return "trans-custodial"
    return "ok"


async def fake_get_user_signer(user):
    raise AssertionError("get_user_signer must never be reached for a wallet session")


async def fake_rpc_tx(tx_hash, sender):
    ST.tx_lookups += 1
    if ST.tx is None:
        raise RuntimeError("no tx")
    return ST.tx


class FakeResp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


class FakeClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, headers=None, **k):
        if not str(url).startswith("http://shade.test"):
            raise AssertionError(f"unexpected network call {url}")
        p = str(url)[len("http://shade.test"):]
        ST.shade.append((p, json))
        default = {
            "/rpc/fastfs/prepare_upload": {"file_key": "K", "file_ref": "file-1", "location": LOCATION},
            "/rpc/fastfs/finalize_upload": {"location": LOCATION},
            "/rpc/access-windows/get": {"window": None},
        }.get(p, {})
        return FakeResp(ST.shade_status.get(p, 200), ST.shade_body.get(p, default))

REAL_RPC_TX = S._rpc_tx_status
S.view_contract = fake_view
S.call_contract = fake_call_contract
S.get_user_signer = fake_get_user_signer
S._rpc_tx_status = fake_rpc_tx
S.httpx.AsyncClient = FakeClient
S.CHAIN_SETTLE_SECONDS = 0.05
S.CHAIN_POLL_SECONDS = 0.01


def tool(name):
    return getattr(getattr(S, name), "__inner__")


def shade_paths():
    return [p for p, _ in ST.shade]


def record_tx(**over):
    args = {"group_id": GROUP, "user_id": ALICE, "file_hash": FILE_HASH,
            "ipfs_hash": LOCATION, "backend": "FastFS"}
    args.update(over.pop("args", {}))
    for k in over.pop("drop_args", []):
        args.pop(k)
    fc = {"method_name": over.pop("method", "record_transaction"),
          "args": base64.b64encode(json.dumps(args).encode()).decode(),
          "gas": 100, "deposit": "1"}
    actions = over.pop("actions", [{"FunctionCall": fc}])
    tx = {"signer_id": over.pop("signer", ALICE), "receiver_id": over.pop("receiver", CONTRACT),
          "actions": actions}
    status = over.pop("status", {"SuccessValue": base64.b64encode(json.dumps("trans-42").encode()).decode()})
    return {"transaction": tx, "status": status}


async def expect_raises(coro, needle):
    try:
        await coro
    except Exception as e:
        assert needle.lower() in str(e).lower(), f"wrong error: {type(e).__name__}: {e}"
        return
    raise AssertionError(f"expected an error containing {needle!r}")


async def prepare(user=None):
    return await tool("prepare_upload")(None, user or wallet_user(), group_id=GROUP, filename="f.txt")


async def finalize(upload_id, user=None, **kw):
    args = dict(upload_id=upload_id, encrypted_data="Y2lwaGVy", file_hash=FILE_HASH, format=None, tx_hash=TX)
    args.update(kw)
    return await tool("finalize_upload")(None, user or wallet_user(), **args)


# ── tests ────────────────────────────────────────────────────────────────────
TESTS = []


def t(fn):
    TESTS.append(fn)
    return fn


@t
async def W1_register_owner_creates_key_without_signing():
    await tool("register_group")(None, wallet_user(), group_id=GROUP)
    assert shade_paths() == ["/rpc/key-management/generate_key"], shade_paths()
    assert ST.shade[0][1]["owner"] == ALICE
    assert ST.signed == []


@t
async def W2_register_non_owner_refused_no_key():
    ST.owner = MALLORY
    await expect_raises(tool("register_group")(None, wallet_user(), group_id=GROUP), "not owned on chain")
    assert shade_paths() == [] and ST.signed == []


@t
async def W3_register_waits_for_finality():
    ST.owner_after = 2
    await tool("register_group")(None, wallet_user(), group_id=GROUP)
    assert ST.polls == 3 and shade_paths() == ["/rpc/key-management/generate_key"]


@t
async def W4_register_key_failure_is_an_error():
    ST.shade_status["/rpc/key-management/generate_key"] = 500
    await expect_raises(tool("register_group")(None, wallet_user(), group_id=GROUP), "key creation failed")


@t
async def W5_add_member_checks_chain_then_clears_window():
    out = await tool("add_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB)
    assert "Added" in out and shade_paths() == ["/rpc/access-windows/clear"] and ST.signed == []


@t
async def W6_add_member_not_on_chain_refused():
    ST.members = {}
    await expect_raises(tool("add_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB),
                        "not a member")
    assert shade_paths() == []


@t
async def W7_add_member_non_owner_refused():
    ST.owner = MALLORY
    await expect_raises(tool("add_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB),
                        "not owned on chain")
    assert shade_paths() == []


@t
async def W8_add_member_access_minutes_refused():
    await expect_raises(tool("add_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB,
                                                 access_minutes=60), "custodial group owner")
    assert shade_paths() == [] and ST.signed == []


@t
async def W9_revoke_rotates_only_after_member_gone():
    ST.members = {BOB: False}
    await tool("revoke_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB)
    assert shade_paths()[0] == "/rpc/key-management/rotate_key", shade_paths()
    assert ST.signed == []


@t
async def W10_revoke_member_still_present_refused_no_rotation():
    ST.members = {BOB: True}
    await expect_raises(tool("revoke_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB),
                        "still a member")
    assert shade_paths() == []


@t
async def W11_revoke_non_owner_refused_no_rotation():
    ST.owner = MALLORY
    ST.members = {BOB: False}
    await expect_raises(tool("revoke_group_member")(None, wallet_user(), group_id=GROUP, member_id=BOB),
                        "not owned on chain")
    assert shade_paths() == []


@t
async def W12_retention_set_registers_only():
    await tool("set_group_retention")(None, wallet_user(), group_id=GROUP, retention_days=30)
    assert shade_paths() == ["/rpc/retention/register"] and ST.signed == []


@t
async def W13_retention_clear_never_deregisters():
    await tool("set_group_retention")(None, wallet_user(), group_id=GROUP, retention_days=None)
    assert shade_paths() == [] and ST.signed == []


@t
async def W14_retention_non_owner_refused():
    ST.owner = MALLORY
    await expect_raises(tool("set_group_retention")(None, wallet_user(), group_id=GROUP, retention_days=30),
                        "not owned on chain")
    assert shade_paths() == []


@t
async def W15_retention_registry_failure_is_an_error():
    ST.shade_status["/rpc/retention/register"] = 500
    await expect_raises(tool("set_group_retention")(None, wallet_user(), group_id=GROUP, retention_days=30),
                        "do not set retention on chain")


@t
async def W16_join_via_mcp_refused_for_wallet():
    await expect_raises(tool("join_group")(None, wallet_user(), group_id=GROUP), "own wallet")
    assert ST.signed == []


@t
async def W17_member_window_owner_only():
    out = await tool("get_member_window")(None, wallet_user(), group_id=GROUP, member_id=BOB)
    assert out["window"] is None
    ST.reset()
    ST.owner = MALLORY
    await expect_raises(tool("get_member_window")(None, wallet_user(), group_id=GROUP, member_id=BOB),
                        "only the group owner")


@t
async def W18_prepare_returns_location():
    p = await prepare()
    assert p["location"] == LOCATION and p["key"] == "K"


@t
async def W19_prepare_without_shade_location_refused():
    ST.shade_body["/rpc/fastfs/prepare_upload"] = {"file_key": "K", "file_ref": "file-1"}
    await expect_raises(prepare(), "did not return an upload location")


@t
async def W20_finalize_happy_path_record_first():
    p = await prepare()
    ST.shade.clear()
    ST.tx = record_tx()
    out = await finalize(p["upload_id"])
    assert out == {"location": LOCATION, "cid": LOCATION, "trans_id": "trans-42", "file_hash": FILE_HASH}, out
    assert shade_paths() == ["/rpc/fastfs/finalize_upload"] and ST.signed == []
    assert p["upload_id"] not in S.PENDING_UPLOADS
    await expect_raises(finalize(p["upload_id"]), "invalid or expired")   # no replay


def _valid_fc():
    return record_tx()["transaction"]["actions"][0]


# name → (record_tx overrides, the specific refusal it must produce)
MISMATCHES = {
    "signer": (dict(signer=MALLORY), "not signed by this session"),
    "receiver": (dict(receiver="evil.near"), "not sent to the nova contract"),
    "method": (dict(method="register_group"), "not a record_transaction call"),
    "two_actions": (dict(actions=[_valid_fc(), {"Transfer": {"deposit": "1"}}]), "single function call"),
    "not_function_call": (dict(actions=[{"Transfer": {"deposit": "1"}}]), "single function call"),
    "group_id": (dict(args={"group_id": "other"}), "does not match this upload"),
    "user_id": (dict(args={"user_id": MALLORY}), "does not match this upload"),
    "file_hash": (dict(args={"file_hash": "cd" * 32}), "does not match this upload"),
    "ipfs_hash": (dict(args={"ipfs_hash": f"{CONTRACT}/fastfs.near/{GROUP}/other"}), "does not match this upload"),
    "backend": (dict(args={"backend": "Ipfs"}), "does not match this upload"),
    "extra_arg": (dict(args={"x": 1}), "does not match this upload"),
    "missing_arg": (dict(drop_args=["backend"]), "does not match this upload"),
    "failed_tx": (dict(status={"Failure": {"ActionError": {}}}), "did not succeed"),
    "no_trans_id": (dict(status={"SuccessValue": ""}), "no trans_id"),
}


@t
async def W21_finalize_rejects_every_mismatch_and_writes_nothing():
    for name, (over, needle) in MISMATCHES.items():
        ST.reset()
        p = await prepare()
        ST.shade.clear()
        ST.tx = record_tx(**over)
        try:
            await expect_raises(finalize(p["upload_id"]), needle)
        except AssertionError as e:
            raise AssertionError(f"mismatch '{name}': {e}")
        assert shade_paths() == [], f"mismatch '{name}' wrote bytes: {shade_paths()}"
        assert p["upload_id"] in S.PENDING_UPLOADS, f"mismatch '{name}' consumed the upload"


@t
async def W22_finalize_needs_valid_tx_hash():
    p = await prepare()
    await expect_raises(finalize(p["upload_id"], tx_hash=None), "need tx_hash")
    await expect_raises(finalize(p["upload_id"], tx_hash="not a hash!"), "not a valid transaction hash")
    assert ST.tx_lookups == 0


@t
async def W23_finalize_other_users_upload_refused():
    p = await prepare(wallet_user(ALICE))
    ST.tx = record_tx(signer=MALLORY, args={"user_id": MALLORY})
    await expect_raises(finalize(p["upload_id"], user=wallet_user(MALLORY)), "account mismatch")
    assert ST.tx_lookups == 0


@t
async def W24_shade_write_failure_keeps_upload_retryable():
    p = await prepare()
    ST.tx = record_tx()
    ST.shade_status["/rpc/fastfs/finalize_upload"] = 500
    await expect_raises(finalize(p["upload_id"]), "shade finalize_upload failed")
    assert p["upload_id"] in S.PENDING_UPLOADS
    ST.shade_status.clear()
    out = await finalize(p["upload_id"])
    assert out["trans_id"] == "trans-42"


@t
async def W25_location_mismatch_is_loud():
    p = await prepare()
    ST.tx = record_tx()
    ST.shade_body["/rpc/fastfs/finalize_upload"] = {"location": "somewhere/else"}
    await expect_raises(finalize(p["upload_id"]), "different location")


@t
async def W26_custodial_upload_cannot_be_finalized_by_wallet_path():
    carol = "carol.nova-sdk.near"
    p = await prepare(custodial_user(carol))   # custodial prepare: no expected location
    ST.tx = record_tx(signer=carol, args={"user_id": carol})
    await expect_raises(finalize(p["upload_id"], user=wallet_user(carol)), "not prepared for a wallet")
    assert "/rpc/fastfs/finalize_upload" not in shade_paths()


@t
async def C1_custodial_finalize_rejects_tx_hash():
    p = await prepare(custodial_user())
    await expect_raises(finalize(p["upload_id"], user=custodial_user()), "only accepted from wallet")


@t
async def C2_custodial_upload_unchanged():
    p = await prepare(custodial_user())
    assert "location" not in p
    out = await finalize(p["upload_id"], user=custodial_user(), tx_hash=None)
    assert out["trans_id"] == "trans-custodial"
    assert [m for _, m, _ in ST.signed] == ["record_transaction"]
    assert ST.tx_lookups == 0


@t
async def C3_custodial_owner_ops_still_sign():
    await tool("register_group")(None, custodial_user(), group_id=GROUP)
    await tool("revoke_group_member")(None, custodial_user(), group_id=GROUP, member_id=BOB)
    await tool("set_group_retention")(None, custodial_user(), group_id=GROUP, retention_days=30)
    await tool("join_group")(None, custodial_user(), group_id=GROUP)
    assert [m for _, m, _ in ST.signed] == [
        "register_group", "revoke_group_member", "set_group_retention", "join_group"], ST.signed


@t
async def K1_apikey_session_for_wallet_account_is_self_custodial():
    # The v0.4.10 fix: a wallet account is self-custodial however it signed in.
    u = apikey_wallet_user()
    assert not S.has_custodial_key(u)
    await tool("register_group")(None, u, group_id=GROUP)
    assert shade_paths() == ["/rpc/key-management/generate_key"] and ST.signed == []


@t
async def K2_custody_is_decided_by_account_suffix():
    assert S.has_custodial_key(custodial_user("carol.nova-sdk.near"))
    assert S.has_custodial_key(custodial_user("dave.nova-sdk-7.testnet"))
    for acc in ["alice.near", "nova-sdk.near", "evil-nova-sdk.near", "x.nova-sdk.near.evil.near",
                "74073d8d417459b75466fa2b4725c51dc65723feb2d347f32fe0a468149b76f6", ""]:
        assert not S.has_custodial_key(custodial_user(acc)), acc
    assert not S.has_custodial_key(wallet_user("carol.nova-sdk.near"))   # explicit wallet session wins


@t
async def K3_tx_lookup_transport_failure_is_a_named_refusal():
    # A forged hash makes the RPC hang until timeout; httpx.ReadTimeout has an
    # empty message. The refusal must still name the cause, carry no URL, and
    # leave the upload pending (nothing written).
    class TimeoutClient(FakeClient):
        async def post(self, url, json=None, headers=None, **k):
            if str(url).startswith("http://shade.test"):
                return await super().post(url, json=json, headers=headers, **k)
            raise S.httpx.ReadTimeout("")

    p = await prepare()
    S._rpc_tx_status = REAL_RPC_TX
    S.httpx.AsyncClient = TimeoutClient
    try:
        await expect_raises(finalize(p["upload_id"]), "tx lookup failed: ReadTimeout")
        try:
            await finalize(p["upload_id"])
        except Exception as e:
            assert "apikey" not in str(e).lower() and "http" not in str(e).lower(), str(e)
    finally:
        S._rpc_tx_status = fake_rpc_tx
        S.httpx.AsyncClient = FakeClient
    assert "/rpc/fastfs/finalize_upload" not in shade_paths()
    assert p["upload_id"] in S.PENDING_UPLOADS


async def main():
    failed = 0
    for fn in TESTS:
        ST.reset()
        S.PENDING_UPLOADS.clear()
        try:
            await fn()
            print(f"  ✓ {fn.__name__}")
        except Exception:
            failed += 1
            print(f"  ✗ {fn.__name__}")
            traceback.print_exc(limit=2)
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} passed")
    sys.exit(1 if failed else 0)


asyncio.run(main())

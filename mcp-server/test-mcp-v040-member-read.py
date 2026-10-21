# mcp-server/test-mcp-v040-member-read.py
#
# HARNESS-FIRST (§10) for MCP v0.4.6 (image v40), offline. Imports the REAL server.py and
# stubs only the network seams (view_contract, call_contract, the reader signer, httpx).
#
#   G — get_group_transactions routing: wallet/agent sessions on mainnet use the reader-gated
#       get_transactions_for_group_of with the SESSION-VERIFIED account; custodial sessions keep
#       the signed path; joinable groups keep the free public view; testnet keeps the signed path.
#   U — uploads from wallet/agent sessions are refused BEFORE any Shade call or FastFS write.
#   R — read_owner_gated_view: the verified account always wins over extra args.
#
# RUN (from mcp-server/):  python3 test-mcp-v040-member-read.py [path/to/server.py]
import asyncio, importlib.util, os, sys

os.environ.setdefault("SESSION_TOKEN_SECRET", "x" * 32)
os.environ.setdefault("SHADE_API_URL", "https://shade.invalid")
os.environ.setdefault("INTERNAL_API_SECRET", "internal")
os.environ.setdefault("READER_PRIVATE_KEY", "ed25519:stub")
os.environ.pop("FASTNEAR_API_KEY", None)

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__) or ".", "server.py")
spec = importlib.util.spec_from_file_location("server_under_test", path)
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)

passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print(f"  ✅ {name}")
    else: failed += 1; print(f"  ❌ {name}")

AGENT = "5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288"
agent = {"email": None, "wallet_id": AGENT, "near_account_id": AGENT, "access_token": "t", "session_token": "h"}
wallet_tn = {"email": None, "wallet_id": "bob.testnet", "near_account_id": "bob.testnet", "access_token": "t", "session_token": "h"}
custodial = {"email": None, "wallet_id": None, "near_account_id": "hello-partage.nova-sdk.near",
             "access_token": None, "session_token": "h", "auth_method": "api_key"}

calls = []
JOINABLE = {"open-event"}
async def fake_view(user, method, args):
    calls.append(("view", method, args))
    if method == "is_group_joinable": return args["group_id"] in JOINABLE
    return [{"trans_id": "pub"}]
async def fake_call(user, method_name, args, fee_action, gas=0, extra_attach=0):
    calls.append(("call", method_name, args, user["near_account_id"]))
    return '[{"trans_id": "signed"}]'
reader_calls = []
class FakeReaderAcc:
    async def function_call(self, contract_id, method_name, args, amount, gas):
        reader_calls.append((method_name, args))
        class Res: status = {"SuccessValue": __import__("base64").b64encode(b'[{"trans_id":"reader"}]').decode()}
        return Res()
async def fake_reader_signer(): return FakeReaderAcc()

http_posts = []
class FakeClient:
    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False
    async def post(self, url, **kw):
        http_posts.append(url)
        class R:
            status_code = 200; text = ""
            def json(self_inner): return {"file_key": "k", "file_ref": "ref", "location": "loc"}
        return R()

S.view_contract = fake_view
S.call_contract = fake_call
S.get_reader_signer = fake_reader_signer
S.httpx.AsyncClient = FakeClient

gt = S.get_group_transactions.__inner__
pu = S.prepare_upload.__inner__
fu = S.finalize_upload.__inner__

async def main():
    print("\nG — get_group_transactions routing:")
    calls.clear(); reader_calls.clear()
    r = await gt(None, agent, group_id="payer-acme")
    check("G1 agent, private group (mainnet) → reader view get_transactions_for_group_of",
          reader_calls == [("get_transactions_for_group_of", {"group_id": "payer-acme", "account_id": AGENT})])
    check("G2 … and never the signed path (no custodial key to sign with)", not [c for c in calls if c[0] == "call"])
    check("G3 … returns the reader rows", r == [{"trans_id": "reader"}])
    calls.clear(); reader_calls.clear()
    r = await gt(None, custodial, group_id="payer-acme")
    check("G4 custodial, private group → signed path unchanged, reader unused",
          [c[1] for c in calls if c[0] == "call"] == ["get_transactions_for_group"] and not reader_calls and r == [{"trans_id": "signed"}])
    calls.clear(); reader_calls.clear()
    r1 = await gt(None, agent, group_id="open-event"); r2 = await gt(None, custodial, group_id="open-event")
    check("G5 joinable group → free public view for both tiers", r1 == r2 == [{"trans_id": "pub"}] and not reader_calls
          and not [c for c in calls if c[0] == "call"])
    calls.clear(); reader_calls.clear()
    await gt(None, wallet_tn, group_id="g")
    check("G6 testnet wallet session → no reader call (no reader key on testnet)", not reader_calls)

    print("\nU — uploads from wallet/agent sessions refused up front:")
    http_posts.clear(); before = dict(S.PENDING_UPLOADS)
    try: await pu(None, agent, group_id="payer-acme", filename="x"); refused = False
    except ValueError as e: refused = "not supported" in str(e)
    check("U1 agent prepare_upload → refused", refused)
    check("U2 … before ANY Shade/FastFS call", http_posts == [])
    check("U3 … and no pending upload created", S.PENDING_UPLOADS == before)
    http_posts.clear()
    r = await pu(None, custodial, group_id="payer-acme", filename="x")
    check("U4 custodial prepare_upload → proceeds to Shade as before", any("fastfs/prepare_upload" in u for u in http_posts) and r["key"] == "k")
    S.PENDING_UPLOADS["u-agent"] = {"group_id": "g", "filename": "x", "file_ref": "r", "user_id": AGENT,
                                    "expires_at": 9e18}
    http_posts.clear()
    try: await fu(None, agent, upload_id="u-agent", encrypted_data="AA==", file_hash="a" * 64); refused = False
    except ValueError: refused = True
    check("U5 agent finalize_upload (smuggled upload_id) → refused before any write", refused and http_posts == [])

    print("\nR — reader args:")
    reader_calls.clear()
    await S.read_owner_gated_view("get_transactions_for_group_of", AGENT, {"group_id": "g", "account_id": "victim.near"})
    check("R1 the verified account overrides an account_id smuggled in extra args",
          reader_calls[-1][1] == {"group_id": "g", "account_id": AGENT})
    reader_calls.clear()
    await S.read_owner_gated_view("get_member_groups_of", AGENT)
    check("R2 existing *_of calls unchanged ({account_id} only)", reader_calls[-1][1] == {"account_id": AGENT})

asyncio.run(main())
print(f"\n{'─'*60}\n  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
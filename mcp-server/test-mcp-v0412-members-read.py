# mcp-server/test-mcp-v0412-members-read.py
#
# HARNESS-FIRST (§10) for MCP v0.4.12, offline. Imports the REAL server.py and
# stubs only the network seams (view_contract, call_contract, the reader signer).
#
#   M — get_group_members routing: wallet/agent sessions on mainnet use the reader-gated
#       get_group_members_of (contract v0.3.8) with the SESSION-VERIFIED account; custodial
#       sessions keep the signed path; joinable groups keep the free public view; testnet
#       keeps the signed path (no reader key there).
#   E — a contract refusal from the reader view surfaces as an error, never as [].
#
# RUN (from mcp-server/):  python3 test-mcp-v0412-members-read.py [path/to/server.py]
import asyncio, base64, importlib.util, os, sys

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
# wallet account signed in with an API key: no wallet_id, but not a NOVA sub-account → self-custodial
wallet_apikey = {"email": None, "wallet_id": None, "near_account_id": "ironclaw-hackathon.near",
                 "access_token": None, "session_token": "h", "auth_method": "api_key"}
wallet_tn = {"email": None, "wallet_id": "bob.testnet", "near_account_id": "bob.testnet", "access_token": "t", "session_token": "h"}
custodial = {"email": None, "wallet_id": None, "near_account_id": "hello-partage.nova-sdk.near",
             "access_token": None, "session_token": "h", "auth_method": "api_key"}

MEMBERS = ["hello-partage.nova-sdk.near", "gmail-14.nova-sdk.near"]
calls = []
JOINABLE = {"open-event"}
async def fake_view(user, method, args):
    calls.append(("view", method, args))
    if method == "is_group_joinable": return args["group_id"] in JOINABLE
    return ["public-member"]
async def fake_call(user, method_name, args, fee_action, gas=0, extra_attach=0):
    calls.append(("call", method_name, args, user["near_account_id"]))
    return '["signed-member"]'

reader_calls = []
reader_mode = {"fail": False}
class FakeReaderAcc:
    async def function_call(self, contract_id, method_name, args, amount, gas):
        reader_calls.append((contract_id, method_name, args, amount))
        class Res: pass
        r = Res()
        if reader_mode["fail"]:
            r.status = {"Failure": {"ActionError": "Smart contract panicked: Unauthorized: not a member"}}
        else:
            import json
            r.status = {"SuccessValue": base64.b64encode(json.dumps(MEMBERS).encode()).decode()}
        return r
async def fake_reader_signer(): return FakeReaderAcc()

S.view_contract = fake_view
S.call_contract = fake_call
S.get_reader_signer = fake_reader_signer

gm = S.get_group_members.__inner__ if hasattr(S.get_group_members, "__inner__") else S.get_group_members

def reset(): calls.clear(); reader_calls.clear(); reader_mode["fail"] = False
def signed(): return [c for c in calls if c[0] == "call"]

async def main():
    print("\nM — get_group_members routing:")
    reset()
    r = await gm(None, agent, group_id="engine-test-evt")
    check("M1 agent, private group (mainnet) → reader view get_group_members_of, verified account",
          [(c[1], c[2]) for c in reader_calls] == [("get_group_members_of", {"group_id": "engine-test-evt", "account_id": AGENT})])
    check("M2 … on the mainnet contract, no deposit",
          reader_calls and reader_calls[0][0] == S.READER_ACCOUNT_ID and reader_calls[0][3] == 0)
    check("M3 … never the signed path (no custodial key to sign with)", not signed())
    check("M4 … returns the reader's member list", r == MEMBERS)

    reset()
    r = await gm(None, wallet_apikey, group_id="engine-test-evt")
    check("M5 wallet account on an API-key session → reader view (custody by suffix, not by sub)",
          [c[1] for c in reader_calls] == ["get_group_members_of"]
          and reader_calls[0][2]["account_id"] == "ironclaw-hackathon.near" and not signed() and r == MEMBERS)

    reset()
    r = await gm(None, custodial, group_id="engine-test-evt")
    check("M6 custodial, private group → signed get_group_members unchanged, reader unused",
          [c[1] for c in signed()] == ["get_group_members"] and not reader_calls and r == ["signed-member"])

    reset()
    r1 = await gm(None, agent, group_id="open-event"); r2 = await gm(None, custodial, group_id="open-event")
    check("M7 joinable group → free public view for both tiers, nothing signed",
          r1 == r2 == ["public-member"] and not reader_calls and not signed()
          and [c[1] for c in calls if c[0] == "view"].count("get_group_members_public") == 2)

    reset()
    await gm(None, wallet_tn, group_id="g")
    check("M8 testnet wallet session → no reader call (no reader key on testnet)", not reader_calls)

    print("\nE — reader refusal surfaces:")
    reset(); reader_mode["fail"] = True
    try:
        r = await gm(None, agent, group_id="engine-test-evt"); raised = False
    except RuntimeError as e:
        raised = "not a member" in str(e)
    check("E1 contract refusal (non-member) → error carrying the contract message, not an empty list", raised)
    check("E2 … and no fallback to the signed path", not signed())

asyncio.run(main())
print(f"\n{'─'*60}\n  {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
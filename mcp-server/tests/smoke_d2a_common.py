# smoke_d2a_common.py — shared helpers for the D2 (A) production security smokes.
# Stdlib only. The session token is read from the environment, never printed:
# only its fingerprint (sha256, 12 hex) appears in output.
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

MCP_URL = os.environ.get(
    "MCP_URL", "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network"
).rstrip("/")
VIEW_RPC = os.environ.get("VIEW_RPC", "https://rpc.mainnet.near.org")  # public, keyless, read-only
CONTRACT = os.environ.get("CONTRACT_ID", "nova-sdk.near")


def fp(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def load_session() -> tuple[str, str]:
    token = os.environ.get("NOVA_WALLET_SESSION", "")
    if not token:
        sys.exit("Set NOVA_WALLET_SESSION first:  read -rs NOVA_WALLET_SESSION && export NOVA_WALLET_SESSION")
    try:
        payload = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    except Exception:
        sys.exit("NOVA_WALLET_SESSION is not a JWT")
    sub = payload.get("sub", "")
    account = payload.get("account_id", "")
    if not account or account.endswith(".nova-sdk.near") or account.endswith(".nova-sdk-7.testnet"):
        sys.exit(f"Not a self-custodial account ({account or 'none'}); fingerprint={fp(token)}")
    print(f"  session type={sub.split('|')[0]}")
    print(f"  session fingerprint={fp(token)} account={account}")
    return token, account


def tool(name: str, body: dict, token: str, account: str) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{MCP_URL}/tools/{name}",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "x-account-id": account,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def view(method: str, args: dict):
    payload = {
        "jsonrpc": "2.0", "id": "v", "method": "query",
        "params": {
            "request_type": "call_function", "finality": "final", "account_id": CONTRACT,
            "method_name": method, "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
        },
    }
    req = urllib.request.Request(VIEW_RPC, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    if data.get("error"):
        raise RuntimeError(data["error"])
    return json.loads(bytes(data["result"]["result"]).decode() or "null")


class Checks:
    def __init__(self):
        self.failed = 0

    def refused(self, label: str, status: int, body: dict, needle: str):
        err = str(body.get("error", ""))
        ok = status >= 400 and "result" not in body and needle.lower() in err.lower()
        self.failed += 0 if ok else 1
        print(f"  {'✓' if ok else '✗'} {label}  [{status}] {err[:140] or json.dumps(body)[:140]}")

    def true(self, label: str, cond: bool, detail: str = ""):
        self.failed += 0 if cond else 1
        print(f"  {'✓' if cond else '✗'} {label}{('  ' + detail) if detail else ''}")

    def done(self, name: str):
        print(f"\n{name}: {'PASS' if not self.failed else f'FAIL ({self.failed})'}\n")
        sys.exit(1 if self.failed else 0)

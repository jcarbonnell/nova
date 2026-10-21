#!/usr/bin/env python3
"""
aa_identity.py: live end-to-end test of NOVA's Agent Connect identity sign-in, using the test
agent created by aa_setup.py (owner devbot.near).

Run from ~/near/nova/paid-handoff (reads ./.env, ./aa-state.json, ./.grant-token).

    .venv/bin/python aa_identity.py --enable    # 1. owner adds sign.recipients=[nova-sdk.near] (one signature)
    .venv/bin/python aa_identity.py --signin    # 2. challenge → Agent API sign → NOVA verify → MCP calls
                                                #    (hosted api.agentsonintents.com only: `sign` policy)
    .venv/bin/python aa_identity.py --enable-native   # demo deployment: native.near.sign_message=[nova-sdk.near]
    .venv/bin/python aa_identity.py --signin-native   # smoke test once Shade + frontend support native
    .venv/bin/python aa_identity.py --probe-native    # NOVA challenge → native/near/sign-message → NOVA verify;
                                                      # saves ./native-sign-fixture.json (public data) for Shade's harness

--signin writes the NOVA session to ./.nova-agent-session (chmod 600) for the next test step.
Nothing secret is printed: not the API key, not the grant token, not the NOVA session.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from aa_setup import (  # noqa: E402
    ENV_FILE, GRANT_FILE, die, guarded_signer, import_asset, load_env, load_state, owner_key,
    check_full_access, run_intent, save_state, write_private,
)

NOVA = "https://nova-sdk.com"
MCP = "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network"
AUDIENCE = "nova-sdk.near"
SESSION_FILE = Path.cwd() / ".nova-agent-session"


def enable(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    view = api.get_policy(agent_id)
    if not (view.get("status") == "APPLIED" and view.get("provider_policy_synced")):
        die(f"current policy not in force: {view.get('status')} synced={view.get('provider_policy_synced')}")
    policy = dict(view["policy"])
    if (policy.get("sign") or {}).get("recipients") == [AUDIENCE]:
        print(f"✓ sign.recipients already [{AUDIENCE}] (revision {view.get('revision')})")
        return
    policy["sign"] = {"recipients": [AUDIENCE]}
    print("new policy (complete, as it will be signed):")
    print(json.dumps(policy, indent=2))

    net = api.get_network()
    key = owner_key(m)
    check_full_access(m, key, rpc_url)
    sign = guarded_signer(m, key, rpc_url, net["contract_id"])
    req = {"type": "policy_update", "agent_id": agent_id, "policy": policy,
           "expected_revision": view["revision"]}
    st = run_intent(m, api, state, "policy_sign", req, sign)
    if st["status"] != "SUCCESS":
        die(f"policy_update ended {st['status']} failure_code={st.get('failure_code')}")
    for _ in range(12):
        v = api.get_policy(agent_id)
        if v.get("status") == "APPLIED" and v.get("provider_policy_synced") \
                and (v.get("policy") or {}).get("sign", {}).get("recipients") == [AUDIENCE]:
            print(f"✓ policy revision {v.get('revision')} APPLIED + synced with sign.recipients=[{AUDIENCE}]")
            state["sign_enabled"] = True
            save_state(state)
            return
        print(f"· policy {v.get('status')} synced={v.get('provider_policy_synced')}; waiting")
        time.sleep(10)
    die("policy not in force after ~2 min; rerun --enable later (it resumes)")


NATIVE_OFF = {
    "near": {"sign_message": [], "transfer": False, "call": []},
    "evm": {"sign_typed_data": [], "sign_message": False, "sign_transaction": False},
    "solana": {"sign_message": False, "sign_transaction": False},
}


def enable_native(m, api, state, rpc_url: str) -> None:
    agent_id = state["agent_id"]
    view = api.get_policy(agent_id)
    if not (view.get("status") == "APPLIED" and view.get("provider_policy_synced")):
        die(f"current policy not in force: {view.get('status')} synced={view.get('provider_policy_synced')}")
    policy = dict(view["policy"])
    native = json.loads(json.dumps(policy.get("native") or NATIVE_OFF))
    if native["near"]["sign_message"] == [AUDIENCE]:
        print(f"✓ native.near.sign_message already [{AUDIENCE}] (revision {view.get('revision')})")
        return
    native["near"]["sign_message"] = [AUDIENCE]  # transfer / call / evm / solana stay off
    policy["native"] = native
    print("new policy (complete, as it will be signed):")
    print(json.dumps(policy, indent=2))
    net = api.get_network()
    key = owner_key(m)
    check_full_access(m, key, rpc_url)
    sign = guarded_signer(m, key, rpc_url, net["contract_id"])
    req = {"type": "policy_update", "agent_id": agent_id, "policy": policy,
           "expected_revision": view["revision"]}
    st = run_intent(m, api, state, "policy_native", req, sign)
    if st["status"] != "SUCCESS":
        die(f"policy_update ended {st['status']} failure_code={st.get('failure_code')}")
    for _ in range(12):
        v = api.get_policy(agent_id)
        n = ((v.get("policy") or {}).get("native") or {}).get("near", {})
        if v.get("status") == "APPLIED" and v.get("provider_policy_synced") and n.get("sign_message") == [AUDIENCE]:
            print(f"✓ policy revision {v.get('revision')} APPLIED + synced; native.near.sign_message=[{AUDIENCE}]")
            return
        print(f"· policy {v.get('status')} synced={v.get('provider_policy_synced')}; waiting")
        time.sleep(10)
    die("policy not in force after ~2 min; rerun --enable-native later (it resumes)")


def probe_native(m, api, state) -> None:
    import base64
    import secrets
    agent_id = state["agent_id"]
    agent = api.for_grant(GRANT_FILE.read_text().strip())
    wallet = (api.get_agent(agent_id).get("wallet") or {}).get("near_account_id")

    s, ch = post_json(m, f"{NOVA}/api/auth/agent-identity/challenge")
    if s != 200:
        die(f"challenge: {s} {ch}")
    nonce = ch.get("nonce") or base64.b64encode(secrets.token_bytes(32)).decode()
    print(f"✓ challenge issued; NOVA returned a nonce: {'yes' if ch.get('nonce') else 'no (using a local one)'}")

    try:
        sig = agent.request("POST", f"/v1/agents/{agent_id}/native/near/sign-message",
                            body={"message": ch["message"], "recipient": ch["audience"], "nonce": nonce},
                            grant=True)
    except m.AgentApiError as e:
        die(f"native sign-message refused: {e.status} {e.code} ({e.detail}) request_id={e.request_id}")
    print(f"✓ native sign-message: account {sig.get('near_account_id')} (wallet {wallet}), "
          f"key {sig.get('public_key')}, signature {len(sig.get('signature', ''))} chars base64, "
          f"nonce echoed: {sig.get('nonce') == nonce}, op {sig.get('correlation_id')}")

    fixture = {"message": ch["message"], "recipient": ch["audience"], "nonce": nonce,
               "near_account_id": sig.get("near_account_id"), "public_key": sig.get("public_key"),
               "signature_base64": sig.get("signature"), "captured_at": int(time.time()),
               "source": "api.demo.agentsonintents.com native/near/sign-message"}
    out = Path.cwd() / "native-sign-fixture.json"
    out.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"✓ wrote {out} (public data only)")

    fwd = {k: sig.get(k) for k in ("near_account_id", "public_key", "signature", "nonce", "recipient")}
    s, v = post_json(m, f"{NOVA}/api/auth/agent-identity/verify", {"challenge": ch["challenge"], "signature": fwd})
    print(f"NOVA verify (expected to be refused until Shade supports native): {s} {v.get('code') or v.get('error')}")
    if s == 200 and v.get("token"):
        write_private(SESSION_FILE, v["token"] + "\n")
        print(f"✓ session saved to {SESSION_FILE}")


def post_json(m, url: str, body: dict | None = None, headers: dict | None = None):
    r = m.httpx.post(url, json=body if body is not None else {}, headers=headers or {}, timeout=30)
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = {"_raw": r.text[:300]}
    return r.status_code, data


def signin(m, api, state) -> None:
    agent_id = state["agent_id"]
    if not GRANT_FILE.exists():
        die(f"{GRANT_FILE} missing")
    agent = api.for_grant(GRANT_FILE.read_text().strip())
    wallet = (api.get_agent(agent_id).get("wallet") or {}).get("near_account_id")
    print(f"agent NEAR Intents account: {wallet}")

    # 1. NOVA challenge
    s, ch = post_json(m, f"{NOVA}/api/auth/agent-identity/challenge")
    if s != 200:
        die(f"challenge: {s} {ch}")
    print(f"✓ challenge issued (audience {ch['audience']}, expires {ch['expires_at_ms']})")
    if ch["audience"] != AUDIENCE:
        die(f"audience {ch['audience']!r} != {AUDIENCE!r}")

    # 2. Agent API signs NOVA's message verbatim
    try:
        sig = agent.request("POST", f"/v1/agents/{agent_id}/sign",
                            body={"message": ch["message"], "recipient": ch["audience"]}, grant=True)
    except m.AgentApiError as e:
        die(f"Agent API sign refused: {e.status} {e.code} ({e.detail}) request_id={e.request_id}")
    print(f"✓ Agent API signed as {sig.get('near_account_id')} with {sig.get('public_key')}")
    if sig.get("near_account_id") != wallet:
        print(f"! signing account {sig.get('near_account_id')} != wallet account {wallet}")

    # 3. NOVA verifies and mints a session
    s, v = post_json(m, f"{NOVA}/api/auth/agent-identity/verify",
                     {"challenge": ch["challenge"], "signature": sig})
    if s != 200:
        die(f"NOVA verify refused: {s} {v}")
    token = v.get("token")
    if not token:
        die(f"verify returned no token: { {k: v.get(k) for k in ('account_id', 'expires_in')} }")
    write_private(SESSION_FILE, token + "\n")
    print(f"✓ NOVA session for {v.get('account_id')} (expires_in {v.get('expires_in')}); saved to {SESSION_FILE}")

    # 4. Replay must fail (challenge is single-use)
    s, r = post_json(m, f"{NOVA}/api/auth/agent-identity/verify",
                     {"challenge": ch["challenge"], "signature": sig})
    print(f"{'✓' if s == 401 else '✗'} replay of the same challenge → {s} {r.get('code')}")

    # 5. The session works on MCP
    h = {"Authorization": f"Bearer {token}", "x-account-id": v["account_id"]}
    for tool, body in (("auth_status", {"group_id": "default"}), ("get_member_groups", {}),
                       ("get_owned_groups", {})):
        s, r = post_json(m, f"{MCP}/tools/{tool}", body, h)
        print(f"{'✓' if s == 200 else '✗'} MCP {tool} → {s} {json.dumps(r)[:300]}")

    state["identity_signin"] = {"account_id": v["account_id"], "at": int(time.time())}
    save_state(state)


def signin_native(m, api, state) -> None:
    """Smoke test after Shade v59 + frontend: security invariants first, then the happy path."""
    import base64
    import secrets
    agent_id = state["agent_id"]
    agent = api.for_grant(GRANT_FILE.read_text().strip())
    wallet = (api.get_agent(agent_id).get("wallet") or {}).get("near_account_id")
    results = []

    def ok(name, cond, extra=""):
        results.append(cond)
        print(f"{'✓' if cond else '✗'} {name}{(' — ' + extra) if extra else ''}")

    def challenge():
        s, ch = post_json(m, f"{NOVA}/api/auth/agent-identity/challenge")
        if s != 200:
            die(f"challenge: {s} {ch}")
        return ch

    def native_sign(ch, nonce):
        try:
            return agent.request("POST", f"/v1/agents/{agent_id}/native/near/sign-message",
                                 body={"message": ch["message"], "recipient": ch["audience"], "nonce": nonce},
                                 grant=True)
        except m.AgentApiError as e:
            die(f"native sign-message refused: {e.status} {e.code} ({e.detail}) request_id={e.request_id}")

    def verify(ch, sig):
        fwd = {k: sig.get(k) for k in ("near_account_id", "public_key", "signature", "nonce", "recipient")}
        return post_json(m, f"{NOVA}/api/auth/agent-identity/verify", {"challenge": ch["challenge"], "signature": fwd})

    # 0. the challenge now carries NOVA's nonce
    ch = challenge()
    n = ch.get("nonce") or ""
    ok("challenge carries a 32-byte base64 nonce", len(n) == 44 and len(base64.b64decode(n)) == 32)
    if not n:
        die("no nonce from NOVA: Shade or frontend not deployed yet")

    # 1. security invariant: a signature over a nonce NOVA did not issue is refused
    own = base64.b64encode(secrets.token_bytes(32)).decode()
    s, r = verify(ch, native_sign(ch, own))
    ok("agent-chosen nonce → refused", s == 401, f"{s} {r.get('code')}")

    # 2. happy path on a fresh challenge with NOVA's nonce
    ch = challenge()
    sig = native_sign(ch, ch["nonce"])
    s, v = verify(ch, sig)
    ok("NOVA's nonce → session issued", s == 200 and bool(v.get("token")), f"{s} account={v.get('account_id')}")
    if s != 200:
        die(f"verify: {s} {v}")
    ok("session account == agent wallet account", v.get("account_id") == wallet)
    write_private(SESSION_FILE, v["token"] + "\n")

    # 3. replay of the same challenge is refused
    s, r = verify(ch, sig)
    ok("replay of a consumed challenge → refused", s == 401, f"{s} {r.get('code')}")

    # 4. the session works on MCP
    h = {"Authorization": f"Bearer {v['token']}", "x-account-id": v["account_id"]}
    for tool, body in (("auth_status", {"group_id": "default"}), ("get_member_groups", {}),
                       ("get_owned_groups", {})):
        s, r = post_json(m, f"{MCP}/tools/{tool}", body, h)
        ok(f"MCP {tool} with the agent session", s == 200, json.dumps(r)[:200])

    state["identity_signin"] = {"account_id": v["account_id"], "at": int(time.time()), "mode": "native"}
    save_state(state)
    print(f"\n{sum(results)}/{len(results)} checks passed; session saved to {SESSION_FILE}")


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--enable", action="store_true")
    g.add_argument("--signin", action="store_true")
    g.add_argument("--enable-native", action="store_true")
    g.add_argument("--probe-native", action="store_true")
    g.add_argument("--signin-native", action="store_true")
    args = ap.parse_args()

    load_env(ENV_FILE)
    m = import_asset()
    import os
    rpc_url = os.environ.get("NEAR_RPC_URL", "https://free.rpc.fastnear.com")
    api = m.AgentApi.from_env()
    state = load_state()
    if not state.get("agent_id"):
        die("no agent_id; run aa_setup.py first")
    if args.enable:
        enable(m, api, state, rpc_url)
    elif args.enable_native:
        enable_native(m, api, state, rpc_url)
    elif args.probe_native:
        probe_native(m, api, state)
    elif args.signin_native:
        signin_native(m, api, state)
    else:
        signin(m, api, state)


if __name__ == "__main__":
    main()
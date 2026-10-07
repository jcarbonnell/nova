#!/usr/bin/env python3
"""
test-fix-a-mcp-auth.py — harness for v0.4 Fix A (MCP auth hole).

Imports the REAL get_current_user from mcp-server/server.py and exercises it
against hand-built tokens. Nothing is reimplemented here: if server.py's logic
differs from what we think it is, these tests fail.

THE CENTRAL TEST IS T4: before Fix A, a request with NO Authorization header but
a bare `x-account-id` + `x-user-email` was ACCEPTED, letting any caller
impersonate any account (account IDs are public on-chain) and have MCP fetch
that account's private key from Shade using MCP's own INTERNAL_API_SECRET.
T4 must now REJECT.

Run from the mcp-server/ directory:
    cd mcp-server
    python3 ../test-fix-a-mcp-auth.py
"""

import os
import sys
import time
import importlib.util
from pathlib import Path

# ── Env must be set BEFORE importing server.py (it reads env at module level) ──
SECRET = "test-session-secret-do-not-use-in-prod"
ISSUER = "https://nova-sdk.com"
AUDIENCE = "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network"

os.environ["SESSION_TOKEN_SECRET"] = SECRET
os.environ["SESSION_TOKEN_ISSUER"] = ISSUER
os.environ["SESSION_TOKEN_AUDIENCE"] = AUDIENCE
os.environ.setdefault("SHADE_API_URL", "http://localhost:3000")
os.environ.setdefault("INTERNAL_API_SECRET", "0" * 64)

import jwt  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa  # noqa: E402

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

get_current_user = server.get_current_user
print(f"Loaded get_current_user from {SERVER_PATH}\n")

VICTIM = "gmail-14.nova-sdk.near"
ATTACKER = "attacker.nova-sdk.near"


class FakeRequest:
    """get_current_user does dict(request.headers) — a dict satisfies that."""
    def __init__(self, headers):
        self.headers = headers


def mint(
    account_id=VICTIM,
    sub=f"email|user@example.com",
    typ="nova_session",
    secret=SECRET,
    issuer=ISSUER,
    audience=AUDIENCE,
    exp_offset=3600,
):
    """Mint an HS256 token with exactly the claims nova-landing's SignJWT emits."""
    now = int(time.time())
    return jwt.encode(
        {
            "account_id": account_id,
            "type": typ,
            "sub": sub,
            "iss": issuer,
            "aud": audience,
            "iat": now,
            "exp": now + exp_offset,
        },
        secret,
        algorithm="HS256",
    )


def mint_rs256():
    """An Auth0-shaped RS256 token — what the chat route used to send (Fix B)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = int(time.time())
    return jwt.encode(
        {
            "account_id": VICTIM,
            "type": "nova_session",
            "sub": f"email|user@example.com",
            "iss": ISSUER,
            "aud": AUDIENCE,
            "iat": now,
            "exp": now + 3600,
        },
        key,
        algorithm="RS256",
    )


def run(name, headers, expect_accept, expect_account=None):
    try:
        user = get_current_user(request=FakeRequest(headers))
        accepted, detail = True, user.get("near_account_id")
    except Exception as e:
        accepted, detail = False, str(e)

    ok = accepted == expect_accept
    if ok and expect_accept and expect_account is not None:
        ok = detail == expect_account

    verdict = "PASS" if ok else "FAIL"
    action = "ACCEPTED" if accepted else "REJECTED"
    print(f"[{verdict}] {name}\n         → {action}: {detail}")
    return ok


results = []

# ── T1: legitimate token, no x-account-id hint ────────────────────────────────
results.append(run(
    "T1  valid nova_session token (no hint header)",
    {"authorization": f"Bearer {mint()}"},
    expect_accept=True, expect_account=VICTIM,
))

# ── T2: legitimate token + matching hint ──────────────────────────────────────
results.append(run(
    "T2  valid token + matching x-account-id",
    {"authorization": f"Bearer {mint()}", "x-account-id": VICTIM},
    expect_accept=True, expect_account=VICTIM,
))

# ── T3: hint disagrees with token — must not honour the hint ──────────────────
results.append(run(
    "T3  valid token + MISMATCHED x-account-id  (hint must never win)",
    {"authorization": f"Bearer {mint(account_id=ATTACKER)}", "x-account-id": VICTIM},
    expect_accept=False,
))

# ── T4: THE HOLE. No token at all, bare header assertion. ─────────────────────
results.append(run(
    "T4  NO token, bare x-account-id + x-user-email  ***THE v0.3.2 HOLE***",
    {"x-account-id": VICTIM, "x-user-email": "anything@example.com"},
    expect_accept=False,
))

# ── T5: RS256 (Auth0) token — the old chat-route bug ──────────────────────────
results.append(run(
    "T5  RS256 Auth0-style token  (alg confusion / old chat route)",
    {"authorization": f"Bearer {mint_rs256()}", "x-account-id": VICTIM},
    expect_accept=False,
))

# ── T6: right alg, wrong signing secret ───────────────────────────────────────
results.append(run(
    "T6  HS256 signed with WRONG secret",
    {"authorization": f"Bearer {mint(secret='wrong-secret')}"},
    expect_accept=False,
))

# ── T7: valid signature, wrong token type ─────────────────────────────────────
results.append(run(
    "T7  valid signature, type != nova_session",
    {"authorization": f"Bearer {mint(typ='something_else')}"},
    expect_accept=False,
))

# ── T8: expired ───────────────────────────────────────────────────────────────
results.append(run(
    "T8  expired token",
    {"authorization": f"Bearer {mint(exp_offset=-60)}"},
    expect_accept=False,
))

# ── T9 / T10: issuer + audience must be enforced ──────────────────────────────
results.append(run(
    "T9  wrong issuer",
    {"authorization": f"Bearer {mint(issuer='https://evil.example')}"},
    expect_accept=False,
))
results.append(run(
    "T10 wrong audience",
    {"authorization": f"Bearer {mint(audience='https://evil.example')}"},
    expect_accept=False,
))

# ── T11: no headers at all ────────────────────────────────────────────────────
results.append(run(
    "T11 empty request",
    {},
    expect_accept=False,
))

# ── T12: wallet-subject token still resolves (SDKs send sub=apikey|...) ───────
results.append(run(
    "T12 apikey-subject token (SDK / nova-submit path)",
    {"authorization": f"Bearer {mint(sub=f'apikey|{VICTIM}')}"},
    expect_accept=True, expect_account=VICTIM,
))

# API-key path (nova-reborn): resolve_user + X-API-Key, Shade stubbed.
# The REAL resolve_user / _user_from_api_key run; only the network is faked.
# ════════════════════════════════════════════════════════════════════════════
import asyncio   # noqa: E402
import logging   # noqa: E402

print("\n── API-key path ──")

VICTIM_KEY = "nova_sk_" + "V" * 43
ATTACKER_KEY = "nova_sk_" + "A" * 43
STORED = {VICTIM: VICTIM_KEY, ATTACKER: ATTACKER_KEY}  # what Shade has on file
shade_calls = []
shade_mode = {"m": "normal"}


async def fake_shade(api_key, account_id):
    shade_calls.append((api_key, account_id))
    m = shade_mode["m"]
    if m == "down":
        raise ConnectionError("shade unreachable")
    if m == "no_key":
        return 401, {"error": "No API key configured", "code": "NO_API_KEY_CONFIGURED"}
    if m == "lying":  # valid:true but for a different account — must still reject
        return 200, {"valid": True, "account_id": ATTACKER, "network": "mainnet"}
    stored = STORED.get(account_id)
    if stored is None:
        return 401, {"error": "No API key configured", "code": "NO_API_KEY_CONFIGURED"}
    return 200, {"valid": stored == api_key, "account_id": account_id, "network": "mainnet"}


server._shade_verify_api_key = fake_shade

# Capture RAW log messages (unfiltered handler) to prove the code never logs the key.
captured = []


class _Capture(logging.Handler):
    def emit(self, record):
        captured.append(record.getMessage())


logging.getLogger().addHandler(_Capture())


def runk(name, headers, expect_accept, expect_account=None, expect_shade=None, mode="normal"):
    shade_calls.clear()
    shade_mode["m"] = mode
    try:
        user = asyncio.run(server.resolve_user(request=FakeRequest(headers)))
        accepted, detail = True, user.get("near_account_id")
    except Exception as e:
        accepted, detail = False, str(e)
    ok = accepted == expect_accept
    if ok and expect_accept and expect_account is not None:
        ok = detail == expect_account
    if ok and expect_shade is not None:
        ok = (len(shade_calls) > 0) == expect_shade
    verdict = "PASS" if ok else "FAIL"
    action = "ACCEPTED" if accepted else "REJECTED"
    print(f"[{verdict}] {name}\n         → {action}: {detail}  (shade calls: {len(shade_calls)})")
    return ok


results.append(runk("K1  valid key + matching x-account-id",
    {"x-api-key": VICTIM_KEY, "x-account-id": VICTIM},
    expect_accept=True, expect_account=VICTIM, expect_shade=True))

results.append(runk("K2  attacker's key claiming the victim's account",
    {"x-api-key": ATTACKER_KEY, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=True))

results.append(runk("K3  victim's key claiming the attacker's account",
    {"x-api-key": VICTIM_KEY, "x-account-id": ATTACKER},
    expect_accept=False, expect_shade=True))

results.append(runk("K4  unknown key",
    {"x-api-key": "nova_sk_" + "Z" * 43, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=True))

results.append(runk("K5  key WITHOUT x-account-id (Shade must not be called)",
    {"x-api-key": VICTIM_KEY},
    expect_accept=False, expect_shade=False))

results.append(runk("K6  malformed key, no nova_sk_ prefix (Shade must not be called)",
    {"x-api-key": "not-a-nova-key", "x-account-id": VICTIM},
    expect_accept=False, expect_shade=False))

results.append(runk("K7  Shade unreachable → fail closed",
    {"x-api-key": VICTIM_KEY, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=True, mode="down"))

results.append(runk("K8  Shade 401 no_key_configured → reject",
    {"x-api-key": VICTIM_KEY, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=True, mode="no_key"))

results.append(runk("K9  Shade says valid but for ANOTHER account → reject",
    {"x-api-key": VICTIM_KEY, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=True, mode="lying"))

results.append(runk("K10 INVALID Bearer + valid key → reject, NO fallback to key path",
    {"authorization": f"Bearer {mint(secret='wrong-secret')}",
     "x-api-key": VICTIM_KEY, "x-account-id": VICTIM},
    expect_accept=False, expect_shade=False))

results.append(runk("K11 VALID Bearer + key → JWT identity wins, Shade not called",
    {"authorization": f"Bearer {mint(account_id=VICTIM)}",
     "x-api-key": ATTACKER_KEY, "x-account-id": VICTIM},
    expect_accept=True, expect_account=VICTIM, expect_shade=False))

results.append(runk("K12 bare x-account-id + x-user-email via resolve_user (T4 through new entry)",
    {"x-account-id": VICTIM, "x-user-email": "anything@example.com"},
    expect_accept=False, expect_shade=False))

leaked = [m for m in captured if "nova_sk_" in m]
k13 = not leaked
print(f"[{'PASS' if k13 else 'FAIL'}] K13 no NOVA API key in any log message"
      f"{'' if k13 else f' — LEAKED in: {leaked[:2]}'}")
results.append(k13)

rec = logging.LogRecord("t", logging.INFO, __file__, 0, f"oops {VICTIM_KEY} here", None, None)
server.RedactSecrets().filter(rec)
k14 = "nova_sk_[REDACTED]" in rec.getMessage() and VICTIM_KEY not in rec.getMessage()
print(f"[{'PASS' if k14 else 'FAIL'}] K14 RedactSecrets scrubs nova_sk_ keys → {rec.getMessage()}")
results.append(k14)

print("\n" + "=" * 66)
if all(results):
    print(f"ALL {len(results)} TESTS PASSED — no unauthenticated path to an identity.")
    sys.exit(0)
else:
    print(f"{results.count(False)}/{len(results)} FAILED — DO NOT DEPLOY.")
    sys.exit(1)

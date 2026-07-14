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

print("\n" + "=" * 66)
if all(results):
    print(f"ALL {len(results)} TESTS PASSED — no unauthenticated path to an identity.")
    sys.exit(0)
else:
    print(f"{results.count(False)}/{len(results)} FAILED — DO NOT DEPLOY.")
    sys.exit(1)

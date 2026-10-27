# NOVA-mcp refactored for Horizon (fastmcp v3+), w/ dual-network support and clean code (removed redundancy)
import os
import asyncio
import json
import hashlib
import re
import time
import logging
from typing import Dict, Any, Callable
from uuid import uuid4
from functools import wraps
from inspect import signature

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

import base64
from py_near.account import Account
from py_near.exceptions.provider import InvalidNonce
import httpx
import jwt

from fastmcp import FastMCP, Context
from fastmcp.server.dependencies import get_http_headers

# ─────────────────
# Configuration
# ─────────────────

CONFIG = {
    "mainnet": {
        "contract_id": os.getenv("CONTRACT_ID", "nova-sdk.near"),
        "rpc_url": os.getenv("RPC_URL", "https://rpc.mainnet.near.org"),
        "account_suffix": os.getenv("ACCOUNT_SUFFIX", ".nova-sdk.near"),
        "is_testnet": False,
    },
    "testnet": {
        "contract_id": os.getenv("TESTNET_CONTRACT_ID", "nova-sdk-7.testnet"),
        "rpc_url": os.getenv("TESTNET_RPC_URL", "https://rpc.testnet.near.org"),
        "account_suffix": os.getenv("TESTNET_ACCOUNT_SUFFIX", ".nova-sdk-7.testnet"),
        "is_testnet": True,
    }
}

SHADE_API_URL = os.getenv("SHADE_API_URL", "")
READER_PRIVATE_KEY = os.getenv("READER_PRIVATE_KEY", "")
READER_ACCOUNT_ID = os.getenv("CONTRACT_ID", "nova-sdk.near")
PINATA_GATEWAY = os.getenv("PINATA_GATEWAY", "")
IPFS_API_KEY = os.getenv("IPFS_API_KEY", "")
IPFS_API_SECRET = os.getenv("IPFS_API_SECRET", "")
SESSION_TOKEN_SECRET = os.getenv("SESSION_TOKEN_SECRET")
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET", "")
FASTNEAR_API_KEY = os.getenv("FASTNEAR_API_KEY", "")
SESSION_TOKEN_ISSUER = os.getenv("SESSION_TOKEN_ISSUER", "https://nova-sdk.com")
SESSION_TOKEN_AUDIENCE = os.getenv("SESSION_TOKEN_AUDIENCE", "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network")

logging.basicConfig(level=logging.INFO)
class RedactSecrets(logging.Filter):
    _PATTERNS = [
        (re.compile(r'([?&]apiKey=)[^&\s"\']+', re.I), r'\1[REDACTED]'),
        (re.compile(r'(Bearer\s+)[A-Za-z0-9._\-]+', re.I), r'\1[REDACTED]'),
        (re.compile(r'(ed25519:)[A-Za-z0-9+/=]{60,}'), r'\1[REDACTED]'),
        (re.compile(r'nova_sk_[A-Za-z0-9_\-]+'), 'nova_sk_[REDACTED]'),
    ]

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for pattern, repl in self._PATTERNS:
            msg = pattern.sub(repl, msg)
        record.msg = msg
        record.args = ()
        return True

for _h in logging.getLogger().handlers:
    _h.addFilter(RedactSecrets())

logger = logging.getLogger(__name__)

logger.info("🌐 NOVA MCP Server v0.4.11 starting (dual-network mode)")
logger.info(f"   Mainnet: {CONFIG['mainnet']['contract_id']} @ {CONFIG['mainnet']['rpc_url']}")
logger.info(f"   Testnet: {CONFIG['testnet']['contract_id']} @ {CONFIG['testnet']['rpc_url']}")

def get_config(account_id: str | None = None) -> dict:
    if account_id and '.testnet' in account_id.lower():
        return CONFIG["testnet"]
    return CONFIG["mainnet"]

# ─────────────────────────────────────────────────────────
# py_near / FastNear Authorization collision
# ─────────────────────────────────────────────────────────
# py_near hardcodes `Authorization: Bearer py-near` on EVERY request
# (providers.py, alongside Referer: tgapp.herewallet.app). FastNear honours the
# Authorization header over the ?apiKey= query param, so it reads that literal
# as an invalid key → 403 "Invalid API key". Only send_tx fails, because reads
# are served from the public tier regardless of key validity — which is why this
# looked like a method gate, then a rate limit, for two days. curl never
# reproduced it: curl sends no Authorization header.
#
# Patched globally rather than per-Account: py_near runs with allow_broadcast=True
# and does not necessarily use the client on _provider._client for transaction
# submission. A module-level patch covers every code path.
if FASTNEAR_API_KEY:
    _orig_httpx_post = httpx.AsyncClient.post

    async def _fastnear_auth_post(self, url, **kwargs):
        if "fastnear" in str(url):
            headers = dict(kwargs.get("headers") or {})
            headers["Authorization"] = f"Bearer {FASTNEAR_API_KEY}"
            kwargs["headers"] = headers
        return await _orig_httpx_post(self, url, **kwargs)

    httpx.AsyncClient.post = _fastnear_auth_post
    logger.info("✅ FastNear Authorization patch active")
else:
    logger.warning("⚠️  FASTNEAR_API_KEY not set — py_near will send 'Bearer py-near'")

# ───────────────────────────
# Account helpers
# ───────────────────────────
    
# NEAR implicit account: 64 lowercase hex = the ed25519 public key itself.
# Agent Connect wallets (and any key-derived account) look like this. It has no
# dot, so before v0.4.5 it was treated as a bare custodial username and got
# '.nova-sdk.near' appended — an invalid (>64 char) account that add_group_member
# and revoke_group_member would have targeted instead of the real one. A suffixed
# 64-hex name can never be a valid NEAR account, so recognising it is unambiguous.
# Deferred: ETH-implicit ('0x' + 40 hex) is NOT recognised here — a 42-char
# custodial username of that shape would be ambiguous (see roadmap).
IMPLICIT_ACCOUNT_RE = re.compile(r'^[0-9a-f]{64}$')
NEAR_ACCOUNT_MAX_LEN = 64

def normalize_account_id(account_id: str) -> str:
    account_id = account_id.strip().lower()
    if '.' in account_id:
        return account_id
    if IMPLICIT_ACCOUNT_RE.match(account_id):
        return account_id
    if not re.match(r'^[a-z0-9_-]{2,64}$', account_id):
        raise ValueError(f"Invalid username format: {account_id}")
    suffix = get_config(account_id)["account_suffix"]
    full = f"{account_id}{suffix}"
    if len(full) > NEAR_ACCOUNT_MAX_LEN:
        raise ValueError(f"Username too long for a NEAR account: {account_id}")
    return full


# ────────────────────────────────────────────────
# Authentication + require_auth Decorator
# ────────────────────────────────────────────────

def get_current_user(
    ctx: Context | None = None,
    request: Request | None = None
) -> dict:
    """Resolve the caller's identity from a verified nova_session token.

    v0.4 SECURITY FIX: this previously fell back to trusting bare `x-account-id`
    + `x-user-email` headers when no valid token was present. /tools/* is a public
    endpoint, so that fallback allowed ANY caller to impersonate ANY account by
    asserting its (public, on-chain) account ID — MCP would then use its own
    INTERNAL_API_SECRET to retrieve that account's private key from Shade and sign
    as them. There is now NO unauthenticated path. Fails closed.
    """
    if ctx is not None:
        headers = get_http_headers()
        token = ctx.token or ""
    elif request is not None:
        headers = dict(request.headers)
        token = headers.get("authorization", "").replace("Bearer ", "")
    else:
        raise ValueError("Must provide either ctx or request")

    if not SESSION_TOKEN_SECRET:
        logger.error("SESSION_TOKEN_SECRET not configured — refusing all requests")
        raise ValueError("Server misconfigured: token verification unavailable")

    if not token:
        raise ValueError("Auth required: missing Bearer session token")

    try:
        payload = jwt.decode(
            token, SESSION_TOKEN_SECRET, algorithms=["HS256"],
            issuer=SESSION_TOKEN_ISSUER, audience=SESSION_TOKEN_AUDIENCE,
        )
    except Exception as e:
        logger.warning(f"Session token rejected: {e}")
        raise ValueError("Auth failed: invalid session token")

    if payload.get("type") != "nova_session" or not payload.get("account_id"):
        raise ValueError("Auth failed: not a NOVA session token")

    verified_id = payload["account_id"]

    # x-account-id is a client HINT only. Never trust it; only cross-check it.
    asserted_id = headers.get("x-account-id")
    if asserted_id and asserted_id != verified_id:
        raise ValueError("Auth failed: account ID mismatch")

    subject = payload.get("sub", "")
    return {
        "email": subject[6:] if subject.startswith("email|") else None,
        "wallet_id": subject[7:] if subject.startswith("wallet|") else None,
        "near_account_id": verified_id,
        "access_token": token,
        "session_token": hashlib.sha256(token.encode()).hexdigest(),
    }

# ────────────────────────────────────────────────────────────────────────────
# API-key authentication (nova-reborn / host-injected credential path)
# ────────────────────────────────────────────────────────────────────────────
# Reborn's egress scanner scrubs session JWTs from response bodies, so a WASM
# guest cannot hold a nova_session. Instead the host injects the NOVA API key as
# X-API-Key on requests to this MCP, and the guest names its account in
# x-account-id. We verify the pair with Shade exactly as the frontend's
# session-token Path 0 does, then trust only Shade's answer.
#
# This is NOT the pre-Fix-A header trust: x-account-id is a CLAIM that the key
# must prove (Shade hash-checks the key against that account's stored hash).
# Fails closed on every non-success, including Shade being unreachable.
#
# The JWT path is untouched: a Bearer, if present, always takes precedence, and
# an invalid Bearer never falls back to the key path.

API_KEY_PREFIX = "nova_sk_"


async def _shade_verify_api_key(api_key: str, account_id: str) -> tuple[int, Any]:
    """Thin transport to Shade /rpc/user-keys/verify-api-key → (status, json|None).
    Kept separate so the harness can stub the network and test the real logic."""
    if not SHADE_API_URL:
        raise RuntimeError("SHADE_API_URL not configured")
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/user-keys/verify-api-key",
            json={"api_key": api_key, "account_id": account_id},
            headers={"Content-Type": "application/json", "X-Internal-Auth": INTERNAL_API_SECRET},
        )
    try:
        data = resp.json()
    except Exception:
        data = None
    return resp.status_code, data


async def _user_from_api_key(api_key: str, claimed_account: str) -> dict:
    claimed = (claimed_account or "").strip()
    account_hash = hashlib.sha256(claimed.encode()).hexdigest()[:12] if claimed else "none"

    if not claimed:
        raise ValueError("Auth required: x-account-id must accompany the X-API-Key credential")
    if not api_key.startswith(API_KEY_PREFIX):
        logger.warning(f"API-key auth rejected (malformed) account={account_hash}")
        raise ValueError("Auth failed: malformed credential")

    try:
        status, data = await _shade_verify_api_key(api_key, claimed)
    except Exception as e:
        logger.warning(f"API-key verification unavailable ({type(e).__name__}) account={account_hash}")
        raise ValueError("Auth failed: credential verification unavailable")

    # Only 200 + valid strictly True is success. 200 {valid:false} is a mismatch.
    if status != 200 or not isinstance(data, dict) or data.get("valid") is not True:
        logger.warning(f"API-key auth rejected (status={status}) account={account_hash}")
        raise ValueError("Auth failed: invalid credential")

    verified = data.get("account_id")
    if verified != claimed:
        logger.warning(f"API-key auth rejected (account mismatch) account={account_hash}")
        raise ValueError("Auth failed: account mismatch")

    logger.info(f"API-key auth ok account={account_hash}")
    return {
        "email": None,
        "wallet_id": None,
        "near_account_id": verified,
        "access_token": None,
        "session_token": hashlib.sha256(f"apikey|{verified}".encode()).hexdigest(),
        "auth_method": "api_key",
    }


async def resolve_user(ctx: Context | None = None, request: Request | None = None) -> dict:
    """Single auth entry point for tools and REST.
    Bearer present → JWT path (unchanged). Else X-API-Key → Shade-verified key
    path. Else → JWT path, which rejects (no unauthenticated identity)."""
    if ctx is not None:
        headers = {k.lower(): v for k, v in get_http_headers().items()}
        bearer = ctx.token or ""
    elif request is not None:
        headers = {k.lower(): v for k, v in dict(request.headers).items()}
        bearer = headers.get("authorization", "").replace("Bearer ", "")
    else:
        raise ValueError("Must provide either ctx or request")

    api_key = headers.get("x-api-key", "")
    if bearer or not api_key:
        return get_current_user(ctx=ctx, request=request)
    return await _user_from_api_key(api_key, headers.get("x-account-id", ""))


def require_auth(func):
    """Auth decorator that preserves original function signature for MCP."""
    
    # Get the original function's signature
    sig = signature(func)
    
    @wraps(func)
    async def wrapper(ctx: Context, **kwargs):  # Use **kwargs to accept named params
        # Extract user from context
        user = await resolve_user(ctx=ctx)
        if not user.get("near_account_id"):
            raise ValueError("No NEAR account configured")
        
        # Call original function with user + original kwargs
        return await func(ctx, user, **kwargs)
    
    # Preserve original signature for MCP introspection
    # Remove 'user' param since it's injected by decorator
    params = [p for name, p in sig.parameters.items() if name not in ('ctx', 'user')]
    new_params = [sig.parameters['ctx']] + params
    wrapper.__signature__ = sig.replace(parameters=new_params)
    wrapper.__inner__ = func
    
    return wrapper

# ────────────────────────
# REST Exposer
# ────────────────────────

def expose_as_rest(path: str, methods: list[str] = ["POST"]):
    def decorator(original_func: Callable):
        # 1. Register as MCP tool (required for chat interface)
        mcp.tool(original_func)

        # 2. Create REST wrapper that calls the SAME function
        @mcp.custom_route(path, methods=methods)
        async def rest_handler(request: Request):
            try:
                body = await request.json()
            except:
                body = {}

            try:
                user = await resolve_user(request=request)
            except Exception as e:
                logger.warning(f"REST {path} auth rejected: {e}")
                return JSONResponse({"error": str(e)}, status_code=401)

            sig = signature(original_func)
            kwargs = {}
            for param in sig.parameters.values():
                if param.name in ("ctx", "user"):
                    continue
                default = param.default if param.default is not param.empty else None
                kwargs[param.name] = body.get(param.name, default)

            try:
                # Call the unwrapped function directly — user is already resolved above.
                unwrapped = getattr(original_func, '__inner__', original_func)
                result = await unwrapped(None, user, **kwargs)
                return JSONResponse({"result": result})
            except Exception as e:
                logger.error(f"REST {path} failed: {e}")
                return JSONResponse({"error": str(e)}, status_code=500)

        # Unique name to avoid inspector confusion
        rest_handler.__name__ = f"rest_{original_func.__name__}"

        return original_func  # return original for @mcp.tool chain

    return decorator

# ─────────────────────────────
# Contract & Shade Integrations
# ─────────────────────────────

async def get_user_signer(user: dict) -> Account:
    near_account_id = user["near_account_id"]
    config = get_config(near_account_id)

    if not SHADE_API_URL:
        raise ValueError("SHADE_API_URL not configured")

    # For SDK flow (session tokens), always use account_id
    payload = {}
    if user["wallet_id"]:
        payload = {"account_id": near_account_id, "wallet_id": user["wallet_id"]}
    else:
        payload = {"account_id": near_account_id}

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/user-keys/retrieve",
            json=payload, 
            headers={
                "Content-Type": "application/json",
                "X-Internal-Auth": INTERNAL_API_SECRET,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade key retrieval failed: {resp.status_code}")
        data = resp.json()
        private_key = data.get("private_key")
        if not private_key:
            raise ValueError("No private_key in Shade response")

    acc = Account(near_account_id, private_key, config["rpc_url"])
    await acc.startup()
    return acc

async def get_reader_signer() -> Account:
    """Signer for owner-gated account views, as nova-sdk.near via the scoped
    reader FC key. Mainnet only (the views live on the mainnet contract). The
    FC key can only call get_owned_groups_of / get_member_groups_of /
    get_transactions_for_group_of (v0.4.6, contract v0.3.7), so a full MCP
    compromise reads group lists and members' file indexes, and nothing else."""
    if not READER_PRIVATE_KEY:
        raise ValueError("READER_PRIVATE_KEY not configured — reader views unavailable")
    config = CONFIG["mainnet"]
    acc = Account(READER_ACCOUNT_ID, READER_PRIVATE_KEY, config["rpc_url"])
    await acc.startup()
    return acc


async def read_owner_gated_view(method_name: str, account_id: str, extra_args: dict | None = None) -> Any:
    """Call an owner-gated account view (signed as the reader) and return its
    decoded result. These are function-call *transactions* (they assert on
    predecessor, so a pure view is ProhibitedInView), gas-only, no deposit.
    `account_id` is ALWAYS the session-verified account, never a client value."""
    acc = await get_reader_signer()
    result = await acc.function_call(
        contract_id=READER_ACCOUNT_ID,
        method_name=method_name,
        args={**(extra_args or {}), "account_id": account_id},
        amount=0,
        gas=30_000_000_000_000,
    )
    if hasattr(result, "status") and isinstance(result.status, dict):
        if "SuccessValue" in result.status:
            raw = result.status["SuccessValue"]
            if raw:
                return json.loads(base64.b64decode(raw).decode())
            return []
        if "Failure" in result.status:
            raise RuntimeError(result.status["Failure"])
    return []

def _resync_nonce(acc: Account, ak_nonce) -> None:
    """py-near 1.1.59 (pinned) reads an access key's nonce from chain ONCE per
    process — class-level Account._access_key_nonce, keyed by private key, read only
    while the entry is 0 — then counts locally, even on failed attempts. Any OTHER
    signer for the same key (Shade's access-window sweep, §6.1 Piece 4 S2, signs as
    custodial owners) leaves MCP's count behind for good, and every later call for
    that user fails InvalidNonce until MCP restarts.
    On InvalidNonce the tx was REJECTED before execution, so resyncing to the
    chain's ak_nonce and retrying ONCE cannot double-execute.
    Relies on py-near internals: re-check on any py-near upgrade (1.2.x already
    computes max(cached, fetched)+1 per tx)."""
    pk = acc._signers[0]
    try:
        ak = int(ak_nonce)
    except (TypeError, ValueError):
        ak = 0
    if ak > 0:
        Account._access_key_nonce[pk] = max(Account._access_key_nonce[pk], ak)
    else:
        Account._access_key_nonce[pk] = 0  # no usable ak_nonce → force a fresh chain read

async def call_contract(
    user: dict,
    method_name: str,
    args: dict,
    fee_action: str,
    gas: int = 100_000_000_000_000,
    extra_attach: int = 0
) -> Any:
    try:
        acc = await get_user_signer(user)
    except Exception as e:
        raise RuntimeError(f"Failed to get signer for {user.get('near_account_id')}: {e}")
    config = get_config(user["near_account_id"])
    fee = await _estimate_fee(fee_action, user["near_account_id"])
    total_attach = fee + extra_attach + 50_000_000_000_000
    logger.info(f"call_contract: method={method_name} fee_action={fee_action} fee={fee} total_attach={total_attach}")

    async def _submit():
        return await acc.function_call(
            contract_id=config["contract_id"],
            method_name=method_name,
            args=args,
            amount=total_attach,
            gas=gas
        )

    try:
        result = await _submit()
    except InvalidNonce as e:
        _resync_nonce(acc, getattr(e, "ak_nonce", None))
        logger.warning(
            f"call_contract: InvalidNonce method={method_name} "
            f"tx_nonce={getattr(e, 'tx_nonce', None)} ak_nonce={getattr(e, 'ak_nonce', None)}; "
            f"resynced, retrying once"
        )
        result = await _submit()

    if hasattr(result, 'status') and isinstance(result.status, dict):
        if "SuccessValue" in result.status and result.status["SuccessValue"]:
            return base64.b64decode(result.status["SuccessValue"]).decode()
        if "Failure" in result.status:
            raise RuntimeError(result.status["Failure"])

    if hasattr(result, 'transaction') and hasattr(result.transaction, 'hash'):
        return result.transaction.hash
    if hasattr(result, 'transaction_outcome'):
        return result.transaction_outcome.id

    return str(result)

async def view_contract(
    user: dict,
    method_name: str,
    args: dict
) -> Any:
    """View-only contract call via direct RPC — no py_near Account needed."""
    config = get_config(user["near_account_id"])
    args_b64 = base64.b64encode(json.dumps(args).encode()).decode()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            config["rpc_url"],
            json={
                "jsonrpc": "2.0",
                "id": "view",
                "method": "query",
                "params": {
                    "request_type": "call_function",
                    "finality": "final",
                    "account_id": config["contract_id"],
                    "method_name": method_name,
                    "args_base64": args_b64,
                }
            }
        )
        data = resp.json()
        if data.get("error"):
            raise RuntimeError(f"RPC error: {data['error']}")
        result_bytes = bytes(data["result"]["result"])
        return json.loads(result_bytes.decode())

async def _estimate_fee(action: str, account_id: str | None = None) -> int:
    config = get_config(account_id)
    args_b64 = base64.b64encode(json.dumps({"action": action}).encode()).decode()
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            config["rpc_url"],
            json={
                "jsonrpc": "2.0",
                "id": "fee",
                "method": "query",
                "params": {
                    "request_type": "call_function",
                    "finality": "final",
                    "account_id": config["contract_id"],
                    "method_name": "estimate_fee",
                    "args_base64": args_b64,
                }
            }
        )
        data = resp.json()
        if data.get("error"):
            logger.warning(f"Fee estimation failed for {action}: {data['error']}")
            return 0
        result_bytes = bytes(data["result"]["result"])
        return int(json.loads(result_bytes.decode()) or 0)

async def _get_shade_key_internal(group_id: str, user: dict) -> str:
    config = get_config(user["near_account_id"])
    body = {
        "group_id": group_id,
        "account_id": user["near_account_id"],
        "contract_id": config["contract_id"]  # Pass explicitly
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/key-management/get_key",
            json=body,
            headers={"X-Internal-Auth": INTERNAL_API_SECRET},
            timeout=15
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade key fetch failed: {resp.status_code} - {resp.text[:200]}")
        data = resp.json()
        return data.get("key") or ""
    
# ────────────────────────────────────────
# Pending Uploads & IPFS (mock on testnet)
# ────────────────────────────────────────

PENDING_UPLOADS: Dict[str, Dict[str, Any]] = {}
UPLOAD_EXPIRY_SECONDS = 300

def cleanup_expired_uploads():
    now = time.time()
    for uid in list(PENDING_UPLOADS):
        if PENDING_UPLOADS[uid].get("expires_at", 0) < now:
            del PENDING_UPLOADS[uid]

TESTNET_MOCK_FILES: Dict[str, Dict[str, Any]] = {}

def generate_mock_cid(data: bytes, filename: str) -> str:
    return f"Qm{hashlib.sha256(data + filename.encode()).hexdigest()[:44]}"

async def _ipfs_upload(encrypted_b64: str, filename: str, account_id: str | None = None) -> str:
    data = base64.b64decode(encrypted_b64)
    config = get_config(account_id)
    if config["is_testnet"]:
        cid = generate_mock_cid(data, filename)
        TESTNET_MOCK_FILES[cid] = {"data": encrypted_b64, "filename": filename}
        return cid
    # Real Pinata upload (unchanged)
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.pinata.cloud/pinning/pinFileToIPFS",
            headers={"pinata_api_key": IPFS_API_KEY, "pinata_secret_api_key": IPFS_API_SECRET},
            files={"file": (filename, data)}
        )
        resp.raise_for_status()
        return resp.json()["IpfsHash"]

async def _ipfs_retrieve(cid: str, account_id: str | None = None) -> str:
    config = get_config(account_id)
    if config["is_testnet"]:
        return TESTNET_MOCK_FILES.get(cid, {"data": ""})["data"]
    # Real IPFS retrieval (unchanged)
    gateway = PINATA_GATEWAY or "https://gateway.pinata.cloud/ipfs"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(f"{gateway}/{cid.lstrip('/')}")
        resp.raise_for_status()
        return base64.b64encode(resp.content).decode()

# ────────────────────
# CORS Middleware for browser clients
# ────────────────────

cors_middleware = [
    Middleware(
        CORSMiddleware,
        allow_origins=[
            "https://nova-sdk.com",
            "https://www.nova-sdk.com",
            "http://localhost:3000",
            "http://localhost:5173",
        ],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS", "DELETE"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "x-user-email",
            "x-account-id", 
            "x-wallet-id",
            "mcp-protocol-version",
            "mcp-session-id",
        ],
        expose_headers=["mcp-session-id"],
    )
]

mcp = FastMCP(
    name="nova-mcp",
    middleware=cors_middleware,
)

# ─────────────
# Session tiers
# ─────────────

def has_custodial_key(user: dict) -> bool:
    """True only for accounts NOVA created and holds the key for: sub-accounts of
    the NOVA account suffix (*.nova-sdk.near / *.nova-sdk-7.testnet). Only the
    NOVA account can create those, so the suffix is proof of custody.

    Decided by the VERIFIED account, not by how the session was minted: a wallet
    account (alice.near, or an Agent Connect implicit account) that signs in
    with an API key (sub 'apikey|…') is still self-custodial — NOVA holds no key
    for it. Before v0.4.10 only sub 'wallet|…' counted, so such sessions took
    the custodial paths (failed signer fetch; orphan file on upload)."""
    if user.get("wallet_id"):
        return False
    account = (user.get("near_account_id") or "").strip().lower()
    return bool(account) and account.endswith(get_config(account)["account_suffix"])


# §6.1 Piece 4 — access windows. Mirrors Shade's AccessWindowSetSchema (1..525_600).
ACCESS_MINUTES_MAX = 525_600  # one year


async def _shade_internal(path: str, body: dict, timeout: float = 15.0) -> httpx.Response:
    """POST to a gated Shade route with MCP's internal secret. Returns the response;
    each caller decides what a non-200 means (fail hard vs best-effort)."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(
            f"{SHADE_API_URL}{path}",
            json=body,
            headers={"Content-Type": "application/json", "X-Internal-Auth": INTERNAL_API_SECRET},
        )


def _validate_access_minutes(access_minutes) -> int:
    # bool is an int subclass in Python: reject it explicitly.
    if isinstance(access_minutes, bool) or not isinstance(access_minutes, int):
        raise ValueError("access_minutes must be an integer number of minutes")
    if not (1 <= access_minutes <= ACCESS_MINUTES_MAX):
        raise ValueError(f"access_minutes must be between 1 and {ACCESS_MINUTES_MAX}")
    return access_minutes


# ──────────────────────────────────────────────────────────────────────────
# Deliverable 2 (A) — wallet-signed writes (self-custodial sessions)
# ──────────────────────────────────────────────────────────────────────────
# A wallet session (subject wallet|<account>) signs and pays its OWN contract
# writes; MCP never signs as it. Each tool's wallet branch only runs NOVA's
# side effect (key creation, rotation, registry, FastFS write) after
# re-reading chain state, or, for retention, the registry step BEFORE the
# chain change. Nothing the client says is trusted: ownership and membership
# come from the contract, and an upload's record tx is fetched from the chain
# and matched field by field against what this upload_id was issued.
#
# Agents (Agent Connect wallets) also have wallet sessions, but cannot sign
# contract calls, so they can never become on-chain owners: every owner-side
# branch below is gated on get_group_owner == session account.

CHAIN_SETTLE_SECONDS = 15.0   # a wallet tx the SDK just sent may not be `final` yet
CHAIN_POLL_SECONDS = 1.0
TX_HASH_RE = re.compile(r'^[1-9A-HJ-NP-Za-km-z]{32,44}$')


async def _await_view(user: dict, method: str, args: dict, want: Any, refusal: str) -> None:
    """Poll a view (final finality) until it equals `want`, or refuse. Covers the
    gap between the wallet returning and the block being final."""
    deadline = time.monotonic() + CHAIN_SETTLE_SECONDS
    while True:
        if await view_contract(user, method, args) == want:
            return
        if time.monotonic() >= deadline:
            raise PermissionError(refusal)
        await asyncio.sleep(CHAIN_POLL_SECONDS)


async def _require_onchain_owner(user: dict, group_id: str) -> None:
    await _await_view(
        user, "get_group_owner", {"group_id": group_id}, user["near_account_id"],
        f"'{group_id}' is not owned on chain by this session's account",
    )


async def _rpc_tx_status(tx_hash: str, sender_id: str) -> dict:
    """Thin transport to RPC `tx` (waits for FINAL). Separate so the harness can stub it."""
    config = get_config(sender_id)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                config["rpc_url"],
                json={
                    "jsonrpc": "2.0", "id": "tx", "method": "tx",
                    "params": {"tx_hash": tx_hash, "sender_account_id": sender_id, "wait_until": "FINAL"},
                },
            )
        data = resp.json()
    except Exception as e:
        # An unknown (e.g. forged) hash makes the RPC wait until our timeout, and
        # httpx timeouts stringify to "". Name the type only: the exception text
        # can carry the RPC URL, which holds ?apiKey=.
        raise RuntimeError(f"RPC tx lookup failed: {type(e).__name__}") from None
    if data.get("error"):
        raise RuntimeError(f"RPC tx lookup failed: {data['error']}")
    if "result" not in data:
        raise RuntimeError("RPC tx lookup failed: no result")
    return data["result"]


def _check_wallet_record_tx(result: dict, signer: str, contract_id: str, expected_args: dict) -> str:
    """Verify an on-chain record_transaction is exactly the one this upload needs,
    signed directly by the session account and successful. Returns its trans_id."""
    tx = result.get("transaction") or {}
    if tx.get("signer_id") != signer:
        raise PermissionError("Upload record was not signed by this session's account")
    if tx.get("receiver_id") != contract_id:
        raise PermissionError("Upload record was not sent to the NOVA contract")
    actions = tx.get("actions") or []
    if len(actions) != 1 or not isinstance(actions[0], dict) or "FunctionCall" not in actions[0]:
        raise PermissionError("Upload record must be a single function call")
    fc = actions[0]["FunctionCall"] or {}
    if fc.get("method_name") != "record_transaction":
        raise PermissionError("Upload record is not a record_transaction call")
    try:
        args = json.loads(base64.b64decode(fc.get("args") or "").decode())
    except Exception:
        raise PermissionError("Upload record args are not JSON")
    if args != expected_args:
        raise PermissionError("Upload record does not match this upload")
    status = result.get("status")
    if not isinstance(status, dict) or "SuccessValue" not in status:
        raise PermissionError("Upload record transaction did not succeed")
    raw = status["SuccessValue"]
    try:
        trans_id = json.loads(base64.b64decode(raw).decode()) if raw else None
    except Exception:
        trans_id = None
    if not isinstance(trans_id, str) or not trans_id:
        raise RuntimeError("Upload record returned no trans_id")
    return trans_id


# ─────────────
# MCP Tools + REST exposure
# ─────────────

@expose_as_rest("/tools/register_group")
@require_auth
async def register_group(ctx: Context, user: dict, group_id: str) -> str:
    if not has_custodial_key(user):
        # D2 (A): the wallet registered (and paid) on chain. Create the group key
        # only once the chain says this session owns the group. Unlike the
        # custodial path, a failed key creation is an error, not silently ignored.
        await _require_onchain_owner(user, group_id)
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{SHADE_API_URL}/rpc/key-management/generate_key",
                json={
                    "group_id": group_id,
                    "owner": user["near_account_id"],
                    "account_id": user["near_account_id"],
                },
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Auth": INTERNAL_API_SECRET,
                    "Authorization": f"Bearer wallet:{user.get('wallet_id') or user['near_account_id']}",
                },
            )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Group registered on chain, but key creation failed: {resp.status_code} - {resp.text[:200]}"
            )
        return f"Group '{group_id}' registered successfully"

    await call_contract(user, "register_group", {"group_id": group_id}, "register_group")

    config = get_config(user["near_account_id"])
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Auth": INTERNAL_API_SECRET,
    }
    if user.get("wallet_id"):
        headers["Authorization"] = f"Bearer wallet:{user['wallet_id']}"
    elif user.get("access_token"):
        headers["Authorization"] = f"Bearer {user['access_token']}"
    
    async with httpx.AsyncClient(timeout=15.0) as client:
        await client.post(
            f"{SHADE_API_URL}/rpc/key-management/generate_key",
            json={
                "group_id": group_id,
                "owner": user["near_account_id"],
                "account_id": user["near_account_id"]
            },
            headers=headers
        )
    return f"Group '{group_id}' registered successfully"

@expose_as_rest("/tools/add_group_member")
@require_auth
async def add_group_member(ctx: Context, user: dict, group_id: str, member_id: str,
                           access_minutes: int | None = None) -> str:
    # §6.1 Piece 4 — optional ACCESS WINDOW ("sell a window, not a copy"). With
    # access_minutes, Shade's scheduler revokes the member about a minute after
    # expiry (signed as this owner, inside the TEE) and rotates the group key.
    #
    # ORDERING — the window list must never miss a sold window, and a re-added
    # member must never inherit an old expiry:
    #   new member + window        → record the window FIRST (abort if that fails),
    #                                then add on-chain; if the add fails, best-effort
    #                                clear (the entry would target a non-member).
    #   new member, no window      → clear any old window FIRST (abort if that
    #                                fails), then add on-chain.
    #   already a member + window  → no add (it would panic): set/extend the window.
    #   already a member, no window → unchanged (contract panics "User already a
    #                                member"); the existing window is NOT touched.
    # Wallet/agent sessions cannot use windows: the scheduler signs as the owner
    # with NOVA's custodial key, which they don't have (Deliverable 2 lifts this).
    member_id = normalize_account_id(member_id)
    config = get_config(user["near_account_id"])
    window_ref = {"group_id": group_id, "member_id": member_id, "contract_id": config["contract_id"]}

    if access_minutes is not None:
        access_minutes = _validate_access_minutes(access_minutes)
        if not has_custodial_key(user):
            raise PermissionError(
                "Access windows need a custodial group owner (API key or email account); "
                "wallet-owned groups are not supported yet"
            )

    if not has_custodial_key(user):
        # D2 (A): the wallet added the member on chain. Confirm owner + membership,
        # then drop any stale window (none should exist: windows are refused for
        # wallet owners above). Nothing is signed here.
        await _require_onchain_owner(user, group_id)
        await _await_view(
            user, "is_authorized", {"group_id": group_id, "user_id": member_id}, True,
            f"{member_id} is not a member of '{group_id}' on chain",
        )
        try:
            await _shade_internal("/rpc/access-windows/clear", window_ref)
        except Exception as e:
            logger.warning(f"add_group_member (wallet): window clear failed (non-fatal): {e}")
        return f"Added {member_id} to group '{group_id}'"

    try:
        already_member = bool(await view_contract(
            user, "is_authorized", {"group_id": group_id, "user_id": member_id}))
    except Exception as e:
        raise RuntimeError(f"Could not check current membership for {member_id}: {e}")

    expires_at = None
    if access_minutes is not None:
        resp = await _shade_internal("/rpc/access-windows/set", {**window_ref, "access_minutes": access_minutes})
        if resp.status_code != 200:
            raise RuntimeError(
                f"Access-window write failed ({resp.status_code}); aborting before on-chain add - {resp.text[:200]}"
            )
        expires_at = resp.json().get("expires_at")
        if already_member:
            return f"{member_id} is already a member of '{group_id}'; access window set until {expires_at}"
    elif not already_member:
        resp = await _shade_internal("/rpc/access-windows/clear", window_ref)
        if resp.status_code != 200:
            raise RuntimeError(
                f"Could not clear a previous access window ({resp.status_code}); aborting before on-chain add - {resp.text[:200]}"
            )

    try:
        await call_contract(
            user=user,
            method_name="add_group_member",
            args={"group_id": group_id, "user_id": member_id},
            fee_action="add_group_member",
        )
    except Exception as e:
        if access_minutes is not None and "already a member" not in str(e).lower():
            try:
                await _shade_internal("/rpc/access-windows/clear", window_ref)
            except Exception as ce:
                logger.warning(f"add_group_member: best-effort window clear failed for {group_id}: {ce}")
        raise

    if access_minutes is not None:
        return f"Added {member_id} to group '{group_id}' with access until {expires_at}"
    return f"Added {member_id} to group '{group_id}'"

@expose_as_rest("/tools/set_group_retention")
@require_auth
async def set_group_retention(ctx: Context, user: dict, group_id: str, retention_days: int | None = None) -> str:
    # §6.1 retention window (contract v0.3.5), owner-gated on-chain. retention_days
    # = None clears the window (retention = forever, the default). No protocol fee.
    # The off-chain expiry driver reads a Shade-held REGISTRY of retention groups
    # (on-chain windows can't be enumerated), so this dual-writes that registry.
    #
    # ORDERING (registry ⊇ on-chain windows, never a subset):
    #   SET   → register in KV FIRST, then set on-chain. If register fails we abort
    #           before touching the chain (no unregistered window). If the on-chain
    #           set then fails, the registry has a harmless extra entry the driver
    #           filters via get_group_retention == None.
    #   CLEAR → clear on-chain FIRST, then best-effort deregister. A failed
    #           deregister leaves a stale entry the driver filters harmlessly, so
    #           it must NOT block the clear.
    headers = {"Content-Type": "application/json", "X-Internal-Auth": INTERNAL_API_SECRET}

    if not has_custodial_key(user):
        # D2 (A): MCP runs BEFORE the wallet's on-chain call. SET → register only
        # (same fail-hard rule). CLEAR → do NOT deregister: the wallet's clear may
        # never land, and an unregistered on-chain window would never be swept.
        # A stale entry is filtered by the driver (get_group_retention == None).
        await _require_onchain_owner(user, group_id)
        if retention_days is None:
            return f"Ready to clear retention for '{group_id}': sign set_group_retention with your wallet"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{SHADE_API_URL}/rpc/retention/register",
                json={"group_id": group_id},
                headers=headers,
            )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Retention registry write failed ({resp.status_code}); "
                f"do not set retention on chain yet - {resp.text[:200]}"
            )
        return f"Registered '{group_id}' for retention: sign set_group_retention with your wallet"

    if retention_days is not None:
        # SET: registry-first, fail hard if the registry write fails.
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{SHADE_API_URL}/rpc/retention/register",
                json={"group_id": group_id},
                headers=headers,
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"Retention registry write failed ({resp.status_code}); "
                    f"aborting before on-chain set - {resp.text[:200]}"
                )
        await call_contract(
            user=user,
            method_name="set_group_retention",
            args={"group_id": group_id, "retention_days": retention_days},
            fee_action="set_group_retention",
        )
        return f"Set retention for group '{group_id}' to {retention_days} days"

    # CLEAR: on-chain first, then best-effort deregister.
    await call_contract(
        user=user,
        method_name="set_group_retention",
        args={"group_id": group_id, "retention_days": retention_days},
        fee_action="set_group_retention",
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{SHADE_API_URL}/rpc/retention/deregister",
                json={"group_id": group_id},
                headers=headers,
            )
    except Exception as e:
        # Non-fatal: a stale registry entry is filtered by the driver's
        # get_group_retention check. Log and move on.
        logger.warning(f"Retention deregister (non-fatal) failed for {group_id}: {e}")
    return f"Cleared retention window for group '{group_id}'"

@expose_as_rest("/tools/join_group")
@require_auth
async def join_group(ctx: Context, user: dict, group_id: str) -> str:
    # Self-service join: the CALLER joins the group (predecessor == the member).
    # Contract enforces the group is joinable AND has an open window; this tool
    # does not (and must not) pass a member_id — you can only join yourself.
    if not has_custodial_key(user):
        raise PermissionError("Wallet sessions join with their own wallet (sign join_group directly)")
    await call_contract(
        user=user,
        method_name="join_group",
        args={"group_id": group_id},
        fee_action="join_group"
    )
    return f"Joined group '{group_id}'"

@expose_as_rest("/tools/create_hackathon_group")
@require_auth
async def create_hackathon_group(
    ctx: Context,
    user: dict,
    group_id: str,
    expires_at: str,
    max_uses: int | None = None,
) -> str:
    # ONE organizer command = "deploy event": register the group as joinable,
    # generate its Shade encryption key, then open the join window.
    # Half-state safe: skips re-registering if the group already exists.
    config = get_config(user["near_account_id"])

    already_exists = await view_contract(
        user,
        "group_contains_key",
        {"group_id": group_id},
    )

    if not already_exists:
        # 1. Register the group as JOINABLE.
        await call_contract(
            user=user,
            method_name="register_group",
            args={"group_id": group_id, "joinable": True},
            fee_action="register_group",
        )

        # 2. Generate the group's Shade encryption key — MUST happen or members
        #    can't get a key to encrypt/decrypt. Mirrors register_group exactly.
        headers = {
            "Content-Type": "application/json",
            "X-Internal-Auth": INTERNAL_API_SECRET,
        }
        if user.get("wallet_id"):
            headers["Authorization"] = f"Bearer wallet:{user['wallet_id']}"
        elif user.get("access_token"):
            headers["Authorization"] = f"Bearer {user['access_token']}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            await client.post(
                f"{SHADE_API_URL}/rpc/key-management/generate_key",
                json={
                    "group_id": group_id,
                    "owner": user["near_account_id"],
                    "account_id": user["near_account_id"],
                },
                headers=headers,
            )

    # 3. Open the join window (idempotent — overwrites any existing window).
    #    If the group exists but was registered NON-joinable, the contract
    #    rejects this with "not joinable" — correct.
    await call_contract(
        user=user,
        method_name="open_hackathon_join",
        args={"group_id": group_id, "expires_at": expires_at, "max_uses": max_uses},
        fee_action="open_hackathon_join",
    )

    return (
        f"Hackathon group '{group_id}' created and open for join "
        f"until {expires_at}" + (f" ({max_uses} max)" if max_uses else "")
    )


@expose_as_rest("/tools/close_hackathon_join")
@require_auth
async def close_hackathon_join(ctx: Context, user: dict, group_id: str) -> str:
    # Manual early-close of a join window (owner only, enforced on-chain).
    # The window also auto-closes at expires_at; this is for closing sooner.
    await call_contract(
        user=user,
        method_name="close_hackathon_join",
        args={"group_id": group_id},
        fee_action="close_hackathon_join",
    )
    return f"Closed join window for group '{group_id}'"

@expose_as_rest("/tools/revoke_group_member")
@require_auth
async def revoke_group_member(ctx: Context, user: dict, group_id: str, member_id: str) -> str:
    member_id = normalize_account_id(member_id)
    config = get_config(user["near_account_id"])

    if not has_custodial_key(user):
        # D2 (A): the wallet revoked on chain. Rotate only once the chain says
        # this session owns the group AND the member is gone.
        await _require_onchain_owner(user, group_id)
        await _await_view(
            user, "is_authorized", {"group_id": group_id, "user_id": member_id}, False,
            f"{member_id} is still a member of '{group_id}' on chain",
        )
    else:
        # Step 1 — on-chain revoke, signed AS THE USER (the group owner)
        await call_contract(
            user=user,
            method_name="revoke_group_member",
            args={"group_id": group_id, "user_id": member_id},
            fee_action="revoke_group_member",
        )

    # Step 2 — rotate the group key so the revoked member can't decrypt future uploads.
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/key-management/rotate_key",
            json={
                "group_id": group_id,
                "contract_id": config["contract_id"],
            },
            headers={
                "Content-Type": "application/json",
                "X-Internal-Auth": INTERNAL_API_SECRET,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Revoked on-chain, but key rotation failed: {resp.status_code} - {resp.text[:200]}"
            )

    # §6.1 Piece 4 — drop any access window for this member (best-effort). The
    # revoke already happened; a stale entry is harmless (the sweep sees a
    # non-member, rotates once more, and removes it).
    try:
        cresp = await _shade_internal(
            "/rpc/access-windows/clear",
            {"group_id": group_id, "member_id": member_id, "contract_id": config["contract_id"]},
        )
        if cresp.status_code != 200:
            logger.warning(f"revoke_group_member: window clear returned {cresp.status_code} (non-fatal)")
    except Exception as e:
        logger.warning(f"revoke_group_member: window clear failed (non-fatal): {e}")

    return f"Revoked {member_id} from group '{group_id}' (key rotated)"

@expose_as_rest("/tools/get_member_window")
@require_auth
async def get_member_window(ctx: Context, user: dict, group_id: str, member_id: str) -> dict:
    # §6.1 Piece 4 — OWNER-ONLY read of a member's access window. Gated on the
    # ON-CHAIN owner (below), so wallet owners (D2 A) may read; agents can never
    # own a group (they cannot sign register_group), so this stays owner-only.
    member_id = normalize_account_id(member_id)
    config = get_config(user["near_account_id"])
    owner = await view_contract(user, "get_group_owner", {"group_id": group_id})
    if owner != user["near_account_id"]:
        raise PermissionError("Only the group owner can read access windows")
    resp = await _shade_internal(
        "/rpc/access-windows/get",
        {"group_id": group_id, "member_id": member_id, "contract_id": config["contract_id"]},
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Access-window read failed ({resp.status_code})")
    return {"group_id": group_id, "member_id": member_id, "window": resp.json().get("window")}

@expose_as_rest("/tools/prepare_upload")
@require_auth
async def prepare_upload(ctx: Context, user: dict, group_id: str, filename: str) -> dict:
    cleanup_expired_uploads()

    # D2 (A): wallet sessions upload RECORD-FIRST. prepare returns the FastFS
    # location; the wallet records it on chain; finalize verifies that tx before
    # any byte is written (no orphan files: the v0.4.6 reason for refusing).
    wallet = not has_custodial_key(user)

    # FastFS + per-file keys (§5.1/§5.2): Shade fixes the FastFS relative path and
    # mints a RANDOM per-file key wrapped under the group key. The client encrypts
    # with THIS key (not the group key), and echoes file_ref back at finalize so we
    # upload to the same path the key is bound to. Auth is via account_id behind
    # the X-Internal-Auth gate, exactly like _get_shade_key_internal.
    config = get_config(user["near_account_id"])
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/fastfs/prepare_upload",
            json={
                "group_id": group_id,
                "account_id": user["near_account_id"],
                "contract_id": config["contract_id"],
            },
            headers={"X-Internal-Auth": INTERNAL_API_SECRET},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade prepare_upload failed: {resp.status_code} - {resp.text[:200]}")
        prep = resp.json()
    file_key = prep["file_key"]
    file_ref = prep["file_ref"]
    expected_location = prep.get("location") if wallet else None
    if wallet and not expected_location:
        raise RuntimeError("Shade did not return an upload location; wallet uploads are unavailable")

    upload_id = str(uuid4())
    PENDING_UPLOADS[upload_id] = {
        "group_id": group_id,
        "filename": filename,
        "file_ref": file_ref,
        "expected_location": expected_location,
        "user_id": user["near_account_id"],
        "user_email": user.get("email"),
        "wallet_id": user.get("wallet_id"),
        "access_token": user.get("access_token"),
        "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
    }

    out = {
        "upload_id": upload_id,
        "key": file_key,
        "group_id": group_id,
        "filename": filename
    }
    if wallet:
        out["location"] = expected_location
    return out

@expose_as_rest("/tools/finalize_upload")
@require_auth
async def finalize_upload(ctx: Context, user: dict, upload_id: str, encrypted_data: str, file_hash: str,
                          format: dict | None = None, tx_hash: str | None = None) -> dict:
    cleanup_expired_uploads()

    wallet = not has_custodial_key(user)
    if wallet and not tx_hash:
        raise ValueError("Wallet uploads need tx_hash: record the upload with your wallet first")
    if not wallet and tx_hash:
        raise ValueError("tx_hash is only accepted from wallet sessions")
    if wallet and not TX_HASH_RE.match(tx_hash):
        raise ValueError("tx_hash is not a valid transaction hash")

    if upload_id not in PENDING_UPLOADS:
        raise ValueError("Invalid or expired upload_id")

    if not re.match(r'^[a-f0-9]{64}$', file_hash, re.IGNORECASE):
        raise ValueError("file_hash must be 64-char hex (SHA-256)")

    ctx_data = PENDING_UPLOADS[upload_id]

    if ctx_data["user_id"] != user["near_account_id"]:
        raise ValueError("Account mismatch - you do not own this upload")

    if wallet:
        return await _finalize_wallet_upload(user, upload_id, ctx_data, encrypted_data, file_hash, format, tx_hash)

    # FastFS write (§5.2): Shade signs the __fastdata envelope (as the KV-owner
    # signer) at the file_ref fixed in prepare_upload, and persists the format
    # metadata. Returns the reader-independent location. NO IPFS upload path.
    config = get_config(user["near_account_id"])
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/fastfs/finalize_upload",
            json={
                "group_id": ctx_data["group_id"],
                "file_ref": ctx_data["file_ref"],
                "encrypted_b64": encrypted_data,
                "format": format,
            },
            headers={"X-Internal-Auth": INTERNAL_API_SECRET},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade finalize_upload failed: {resp.status_code} - {resp.text[:200]}")
        location = resp.json()["location"]

    # Provenance record, signed AS THE USER (unchanged), now with backend=FastFS.
    # location rides the existing ipfs_hash field (contract kept the name for borsh
    # compatibility; backend disambiguates). record_transaction requires the user
    # be is_authorized in the group — the member (gmail-14) passes.
    trans_id = await call_contract(
        user=user,
        method_name="record_transaction",
        args={
            "group_id": ctx_data["group_id"],
            "user_id": ctx_data["user_id"],
            "file_hash": file_hash,
            "ipfs_hash": location,
            "backend": "FastFS",
        },
        fee_action="record_transaction"
    )

    del PENDING_UPLOADS[upload_id]

    return {
        "location": location,
        "cid": location,   # back-compat alias: existing SDK reads result.cid
        "trans_id": trans_id,
        "file_hash": file_hash
    }

async def _finalize_wallet_upload(user: dict, upload_id: str, ctx_data: dict, encrypted_data: str,
                                  file_hash: str, format: dict | None, tx_hash: str) -> dict:
    """D2 (A) record-first finalize: verify the wallet's record_transaction on
    chain, THEN write the ciphertext to the location it recorded."""
    config = get_config(user["near_account_id"])
    expected_location = ctx_data.get("expected_location")
    if not expected_location:
        raise ValueError("This upload was not prepared for a wallet session")

    result = await _rpc_tx_status(tx_hash, user["near_account_id"])
    trans_id = _check_wallet_record_tx(
        result,
        signer=user["near_account_id"],
        contract_id=config["contract_id"],
        expected_args={
            "group_id": ctx_data["group_id"],
            "user_id": ctx_data["user_id"],
            "file_hash": file_hash,
            "ipfs_hash": expected_location,
            "backend": "FastFS",
        },
    )

    # One record, one write: claim the upload before the write so a concurrent
    # finalize with the same tx can't write twice. Restored if the write fails,
    # so the client can retry within the upload's expiry.
    PENDING_UPLOADS.pop(upload_id, None)
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{SHADE_API_URL}/rpc/fastfs/finalize_upload",
                json={
                    "group_id": ctx_data["group_id"],
                    "file_ref": ctx_data["file_ref"],
                    "encrypted_b64": encrypted_data,
                    "format": format,
                },
                headers={"X-Internal-Auth": INTERNAL_API_SECRET},
            )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade finalize_upload failed: {resp.status_code} - {resp.text[:200]}")
        location = resp.json()["location"]
    except Exception:
        PENDING_UPLOADS[upload_id] = ctx_data
        raise

    if location != expected_location:
        # Should be impossible (Shade fixed the path at prepare). Loud: the record
        # points at expected_location but the bytes are elsewhere.
        logger.error(f"wallet upload {upload_id}: location mismatch (recorded != written)")
        raise RuntimeError("Upload written to a different location than recorded on chain")

    return {
        "location": location,
        "cid": location,
        "trans_id": trans_id,
        "file_hash": file_hash,
    }

@expose_as_rest("/tools/prepare_retrieve")
@require_auth
async def prepare_retrieve(ctx: Context, user: dict, group_id: str, ipfs_hash: str) -> dict:
    # `ipfs_hash` carries whatever the on-chain record stored in its location field:
    #   • legacy IPFS CID (Qm… / bafy…) → group key + IPFS fetch, format=null (v0)
    #   • FastFS location ({pred}/{recv}/{rel}) → per-file key + FastFS fetch + format (v1)
    # The SDK's decodeFile dispatches on `format`. Legacy retrieval is preserved
    # indefinitely (§5.2); only the UPLOAD path is FastFS-only.
    is_legacy_cid = ipfs_hash.startswith('Qm') or ipfs_hash.startswith('bafy')

    if is_legacy_cid:
        key = await _get_shade_key_internal(group_id, user)
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash, user["near_account_id"])
        return {
            "key": key,
            "encrypted_b64": encrypted_b64,
            "ipfs_hash": ipfs_hash,
            "location": ipfs_hash,
            "group_id": group_id,
            "format": None,
        }

    # FastFS path — Shade returns the per-file key, the ciphertext, and the format.
    config = get_config(user["near_account_id"])
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/rpc/fastfs/retrieve",
            json={
                "group_id": group_id,
                "location": ipfs_hash,
                "account_id": user["near_account_id"],
                "contract_id": config["contract_id"],
            },
            headers={"X-Internal-Auth": INTERNAL_API_SECRET},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Shade retrieve failed: {resp.status_code} - {resp.text[:200]}")
        r = resp.json()

    return {
        "key": r["file_key"],
        "encrypted_b64": r["encrypted_b64"],
        "ipfs_hash": ipfs_hash,
        "location": r["location"],
        "group_id": group_id,
        "format": r.get("format"),
    }

@expose_as_rest("/tools/auth_status")
@require_auth
async def auth_status(ctx: Context, user: dict, group_id: str = "test_group") -> dict:
    result = {
        "authenticated": True,
        "near_account_id": user["near_account_id"],
        "group_id": group_id
    }
    
    if user["near_account_id"] and group_id != "default":
        try:
            authorized = await view_contract(
                user,
                "is_authorized",
                {"group_id": group_id, "user_id": user["near_account_id"]}
            )
            result["authorized_for_group"] = authorized
        except Exception as e:
            result["authorized_for_group"] = False
            result["auth_error"] = str(e)
    
    return result

async def _list_account_groups(user: dict, reader_view: str, signed_method: str) -> list:
    """Owned/member group listing for the verified account.
    Mainnet: the owner-gated *_of reader views (no user key needed; works for
    wallet users). Testnet: the reader views and reader key exist only on the
    MAINNET contract, so querying them for a testnet account silently returns []
    from the wrong contract. Use the caller-signed read on the account's own
    network instead (custodial accounts; 0.0001 NEAR fee). Deferred: deploy the
    *_of views + a reader key on the testnet contract."""
    account_id = user["near_account_id"]
    if not account_id:
        raise ValueError("No verified account in session")
    if get_config(account_id)["is_testnet"]:
        result = await call_contract(user, signed_method, {}, signed_method)
        if isinstance(result, str):
            try:
                return json.loads(result) or []
            except ValueError:
                logger.warning(f"{signed_method}: non-JSON contract result on testnet")
                raise RuntimeError(f"{signed_method}: unexpected contract result")
        return result or []
    result = await read_owner_gated_view(reader_view, account_id)
    return result or []

@expose_as_rest("/tools/get_owned_groups")
@require_auth
async def get_owned_groups(ctx: Context, user: dict) -> list:
    return await _list_account_groups(user, "get_owned_groups_of", "get_owned_groups")

@expose_as_rest("/tools/get_member_groups")
@require_auth
async def get_member_groups(ctx: Context, user: dict) -> list:
    return await _list_account_groups(user, "get_member_groups_of", "get_member_groups")

@expose_as_rest("/tools/get_group_members")
@require_auth
async def get_group_members(ctx: Context, user: dict, group_id: str) -> list:
    joinable = await view_contract(user, "is_group_joinable", {"group_id": group_id})
    if joinable:
        result = await view_contract(user, "get_group_members_public", {"group_id": group_id})
    else:
        result = await call_contract(user, "get_group_members", {"group_id": group_id}, "get_group_members")
    if isinstance(result, str):
        return json.loads(result) or []
    return result or []

@expose_as_rest("/tools/get_group_transactions")
@require_auth
async def get_group_transactions(ctx: Context, user: dict, group_id: str) -> list:
    # §5.6: joinable groups → free unsigned public view; private groups → signed path.
    joinable = await view_contract(user, "is_group_joinable", {"group_id": group_id})
    if joinable:
        result = await view_contract(user, "get_transactions_for_group_public", {"group_id": group_id})
    elif not has_custodial_key(user) and not get_config(user["near_account_id"])["is_testnet"]:
        # v0.4.6: wallet/agent sessions cannot sign. Reader-gated view (contract
        # v0.3.7): the contract checks the caller is the reader AND that the
        # SESSION-VERIFIED account is a current member. Mainnet only (testnet has
        # no reader key yet → falls through to the signed path, which refuses).
        result = await read_owner_gated_view(
            "get_transactions_for_group_of", user["near_account_id"], {"group_id": group_id})
    else:
        result = await call_contract(user, "get_transactions_for_group", {"group_id": group_id}, "get_transactions_for_group")
    if isinstance(result, str):
        return json.loads(result) or []
    return result or []

# ─────────────────
# Custom Routes 
# ─────────────────

@mcp.custom_route("/", methods=["GET"])
async def root(request: Request):
    """Liveness only — NO external I/O.

    This endpoint answers if and only if the process is alive and serving.
    """
    return JSONResponse({"status": "ok", "service": "nova-mcp"})

@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request):
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                CONFIG["mainnet"]["rpc_url"],
                json={"jsonrpc": "2.0", "id": "health", "method": "status", "params": []},
            )
            rpc_ok = resp.status_code == 200
    except Exception as e:
        rpc_ok = str(e)
    return JSONResponse({"status": "MCP ready", "version": "0.4.11", "auth": "enabled", "rpc_reachable": rpc_ok})

if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8000)
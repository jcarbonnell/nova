# NOVA-mcp refactored for Horizon (fastmcp v3+), w/ dual-network support and clean code (removed redundancy)
import os
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
        "contract_id": os.getenv("TESTNET_CONTRACT_ID", "nova-sdk-6.testnet"),
        "rpc_url": os.getenv("TESTNET_RPC_URL", "https://rpc.testnet.near.org"),
        "account_suffix": os.getenv("TESTNET_ACCOUNT_SUFFIX", ".nova-sdk-6.testnet"),
        "is_testnet": True,
    }
}

SHADE_API_URL = os.getenv("SHADE_API_URL", "")
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

logger.info("🌐 NOVA MCP Server v0.4.3 starting (dual-network mode)")
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
    
def normalize_account_id(account_id: str) -> str:
    account_id = account_id.strip().lower()
    if '.' in account_id:
        return account_id
    if not re.match(r'^[a-z0-9_-]{2,64}$', account_id):
        raise ValueError(f"Invalid username format: {account_id}")
    suffix = get_config(account_id)["account_suffix"]
    return f"{account_id}{suffix}"


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

def require_auth(func):
    """Auth decorator that preserves original function signature for MCP."""
    
    # Get the original function's signature
    sig = signature(func)
    
    @wraps(func)
    async def wrapper(ctx: Context, **kwargs):  # Use **kwargs to accept named params
        # Extract user from context
        user = get_current_user(ctx=ctx)
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
                user = get_current_user(request=request)
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

    result = await acc.function_call(
        contract_id=config["contract_id"],
        method_name=method_name,
        args=args,
        amount=total_attach,
        gas=gas
    )

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
# MCP Tools + REST exposure
# ─────────────

@expose_as_rest("/tools/register_group")
@require_auth
async def register_group(ctx: Context, user: dict, group_id: str) -> str:
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
async def add_group_member(ctx: Context, user: dict, group_id: str, member_id: str) -> str:
    member_id = normalize_account_id(member_id)
    await call_contract(
        user=user,
        method_name="add_group_member",
        args={"group_id": group_id, "user_id": member_id},
        fee_action="add_group_member"
    )
    return f"Added {member_id} to group '{group_id}'"

@expose_as_rest("/tools/set_group_retention")
@require_auth
async def set_group_retention(ctx: Context, user: dict, group_id: str, retention_days: int | None = None) -> str:
    # §6.1 retention window (contract v0.3.5), owner-gated on-chain. retention_days
    # = None clears the window (retention = forever, the default). No protocol fee:
    # set_group_retention isn't in the fees map, so estimate_fee returns 0. This
    # configures the window only — it deletes nothing; the (Ping-driven) retention
    # driver reads get_expired_transactions and does the deleting.
    await call_contract(
        user=user,
        method_name="set_group_retention",
        args={"group_id": group_id, "retention_days": retention_days},
        fee_action="set_group_retention",
    )
    if retention_days is None:
        return f"Cleared retention window for group '{group_id}'"
    return f"Set retention for group '{group_id}' to {retention_days} days"

@expose_as_rest("/tools/join_group")
@require_auth
async def join_group(ctx: Context, user: dict, group_id: str) -> str:
    # Self-service join: the CALLER joins the group (predecessor == the member).
    # Contract enforces the group is joinable AND has an open window; this tool
    # does not (and must not) pass a member_id — you can only join yourself.
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

    return f"Revoked {member_id} from group '{group_id}' (key rotated)"

@expose_as_rest("/tools/prepare_upload")
@require_auth
async def prepare_upload(ctx: Context, user: dict, group_id: str, filename: str) -> dict:
    cleanup_expired_uploads()

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

    upload_id = str(uuid4())
    PENDING_UPLOADS[upload_id] = {
        "group_id": group_id,
        "filename": filename,
        "file_ref": file_ref,
        "user_id": user["near_account_id"],
        "user_email": user.get("email"),
        "wallet_id": user.get("wallet_id"),
        "access_token": user.get("access_token"),
        "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
    }

    return {
        "upload_id": upload_id,
        "key": file_key,
        "group_id": group_id,
        "filename": filename
    }

@expose_as_rest("/tools/finalize_upload")
@require_auth
async def finalize_upload(ctx: Context, user: dict, upload_id: str, encrypted_data: str, file_hash: str, format: dict | None = None) -> dict:
    cleanup_expired_uploads()

    if upload_id not in PENDING_UPLOADS:
        raise ValueError("Invalid or expired upload_id")

    if not re.match(r'^[a-f0-9]{64}$', file_hash, re.IGNORECASE):
        raise ValueError("file_hash must be 64-char hex (SHA-256)")

    ctx_data = PENDING_UPLOADS[upload_id]

    if ctx_data["user_id"] != user["near_account_id"]:
        raise ValueError("Account mismatch - you do not own this upload")

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

@expose_as_rest("/tools/get_owned_groups")
@require_auth
async def get_owned_groups(ctx: Context, user: dict) -> list:
    result = await call_contract(user, "get_owned_groups", {}, "get_owned_groups")
    if isinstance(result, str):
        return json.loads(result) or []
    return result or []

@expose_as_rest("/tools/get_member_groups")
@require_auth
async def get_member_groups(ctx: Context, user: dict) -> list:
    result = await call_contract(user, "get_member_groups", {}, "get_member_groups")
    if isinstance(result, str):
        return json.loads(result) or []
    return result or []

@expose_as_rest("/tools/get_group_members")
@require_auth
async def get_group_members(ctx: Context, user: dict, group_id: str) -> list:
    # §5.6: joinable (open-event) groups get a FREE, UNSIGNED public view — no
    # Shade key retrieval, no fee, no user signature. Private groups keep the
    # signed, paid path unchanged. The @require_auth session boundary (§5.0) still
    # establishes the caller; for joinable groups we simply don't sign the read.
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
    return JSONResponse({"status": "MCP ready", "version": "0.4.3", "auth": "enabled", "rpc_reachable": rpc_ok})

if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8000)
# NOVA-mcp refactored for Horizon (fastmcp v3+), w/ dual-network support and clean code (removed redundancy)
import os
import sqlite3
import json
import hashlib
import re
import time
import logging
from typing import Optional, Dict, Any, Callable
from uuid import uuid4
from contextlib import contextmanager
from functools import wraps
from inspect import signature

from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
from starlette.middleware.cors import CORSMiddleware

import asyncio
import base64

# Crypto / NEAR
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
import base58
import py_near
from py_near.account import Account
import httpx
import jwt

from fastmcp import FastMCP, Context
from fastmcp.server.auth.providers.jwt import JWTVerifier
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
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "https://nova-mcp.fastmcp.app")
AUTH0_ISSUER = os.getenv("AUTH0_ISSUER", "")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID")
AUTH0_CLIENT_SECRET = os.getenv("AUTH0_CLIENT_SECRET")
PINATA_GATEWAY = os.getenv("PINATA_GATEWAY", "")
IPFS_API_KEY = os.getenv("IPFS_API_KEY", "")
IPFS_API_SECRET = os.getenv("IPFS_API_SECRET", "")
RELAYER_URL = os.getenv("RELAYER_URL", "https://relayer.testnet.near.org")
DUMMY_PRIVATE_KEY = "ed25519:" + "A" * 86
SESSION_TOKEN_SECRET = os.getenv("SESSION_TOKEN_SECRET")
SESSION_TOKEN_ISSUER = "https://nova-sdk.com"
SESSION_TOKEN_AUDIENCE = "https://nova-mcp.fastmcp.app"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

logger.info("🌐 NOVA MCP Server v0.4.1 starting (dual-network mode)")
logger.info(f"   Mainnet: {CONFIG['mainnet']['contract_id']} @ {CONFIG['mainnet']['rpc_url']}")
logger.info(f"   Testnet: {CONFIG['testnet']['contract_id']} @ {CONFIG['testnet']['rpc_url']}")

def get_config(account_id: str | None = None) -> dict:
    if account_id and '.testnet' in account_id.lower():
        return CONFIG["testnet"]
    return CONFIG["mainnet"]

# ───────────────────────────
# Database & User Management
# ───────────────────────────

@contextmanager
def get_db():
    conn = sqlite3.connect('nova-users.db', check_same_thread=False)
    try:
        yield conn
    finally:
        conn.close()

# Init DB
with get_db() as conn:
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            near_account_id TEXT,
            unsubscribed BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_email ON users(email)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_near ON users(near_account_id)')
    conn.commit()

def store_user(email: str | None = None, near_account_id: str | None = None) -> int:
    """Store or update user (called after Auth0 callback)."""
    if not email and not near_account_id:
        raise ValueError("Need either email or near_account_id")
    with get_db() as conn:
        cursor = conn.cursor()
        if email:
            cursor.execute("""
                INSERT INTO users (email, near_account_id) 
                VALUES (?, ?)
                ON CONFLICT(email) DO UPDATE SET 
                    near_account_id = COALESCE(excluded.near_account_id, users.near_account_id)
            """, (email, near_account_id))
        else:
            cursor.execute("INSERT OR IGNORE INTO users (near_account_id) VALUES (?)", (near_account_id,))
        conn.commit()
        return cursor.lastrowid

def unsubscribe_user(email: str) -> bool:
    """Mark user as unsubscribed from marketing emails."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET unsubscribed = TRUE WHERE email = ?", (email,))
        conn.commit()
        return cursor.rowcount > 0
    
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
    if ctx is not None:
        headers = get_http_headers()
        token = ctx.token or ""
    elif request is not None:
        headers = dict(request.headers)
        token = headers.get("authorization", "").replace("Bearer ", "")
    else:
        raise ValueError("Must provide either ctx or request")

    user_email = headers.get("x-user-email")
    account_id = headers.get("x-account-id")
    wallet_id = headers.get("x-wallet-id")

    if token and SESSION_TOKEN_SECRET:
        try:
            payload = jwt.decode(
                token, SESSION_TOKEN_SECRET, algorithms=["HS256"],
                issuer=SESSION_TOKEN_ISSUER, audience=SESSION_TOKEN_AUDIENCE,
            )
            if payload.get("type") != "nova_session" or not payload.get("account_id"):
                raise ValueError("Invalid session token")
            verified_id = payload["account_id"]
            if account_id and account_id != verified_id:
                raise ValueError("Account ID mismatch")
            subject = payload.get("sub", "")
            return {
                "email": subject[6:] if subject.startswith("email|") else None,
                "wallet_id": subject[7:] if subject.startswith("wallet|") else None,
                "near_account_id": verified_id,
                "access_token": token,
                "session_token": hashlib.sha256(token.encode()).hexdigest(),
            }
        except Exception as e:
            logger.warning(f"SDK token invalid: {e}")

    if not account_id:
        raise ValueError("Missing x-account-id header")

    if not (user_email or wallet_id):
        raise ValueError("Auth required: missing x-user-email or x-wallet-id")

    session_token = hashlib.sha256(
        f"{wallet_id or user_email or account_id}:{token or 'wallet-only'}".encode()
    ).hexdigest()

    return {
        "email": user_email or None,
        "wallet_id": wallet_id or None,
        "near_account_id": account_id,
        "access_token": token if token else None,
        "session_token": session_token,
    }

def require_auth(func):
    @wraps(func)
    async def wrapper(ctx: Context, *args, **kwargs):
        user = get_current_user(ctx=ctx)
        if not user.get("near_account_id"):
            raise ValueError("No NEAR account configured")
        return await func(ctx, user, *args, **kwargs)
    return wrapper

# ─────────────────────────────
# Contract & Shade Integrations
# ─────────────────────────────

async def get_user_signer(user: dict) -> Account:
    near_account_id = user["near_account_id"]
    config = get_config(near_account_id)

    if not SHADE_API_URL:
        raise ValueError("SHADE_API_URL not configured")

    payload = {}
    if user["email"] and user["access_token"]:
        payload = {"email": user["email"], "auth_token": user["access_token"]}
    elif user["wallet_id"]:
        payload = {"account_id": near_account_id}
    else:
        payload = {"account_id": near_account_id}

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{SHADE_API_URL}/api/user-keys/retrieve",
            json=payload, headers={"Content-Type": "application/json"}
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
    acc = await get_user_signer(user)
    config = get_config(user["near_account_id"])
    fee = await _estimate_fee(fee_action, user["near_account_id"])
    total_attach = fee + extra_attach + 50_000_000_000_000

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
    """View-only contract call – no fee, no gas attached."""
    config = get_config(user["near_account_id"])
    acc = Account("dummy", DUMMY_PRIVATE_KEY, config["rpc_url"])
    await acc.startup()
    
    result = await acc.view_function(
        contract_id=config["contract_id"],
        method_name=method_name,
        args=args
    )
    
    return result.result

async def _estimate_fee(action: str, account_id: str | None = None) -> int:
    config = get_config(account_id)
    acc = Account("dummy", DUMMY_PRIVATE_KEY, config["rpc_url"])
    await acc.startup()
    result = await acc.view_function(
        contract_id=config["contract_id"],
        method_name="estimate_fee",
        args={"action": action}
    )
    return int(result.result or 0)

async def _get_shade_key_internal(group_id: str, user: dict) -> str:
    config = get_config(user["near_account_id"])
    body = {
        "group_id": group_id,
        "account_id": user["near_account_id"],
        "contract_id": config["contract_id"]  # Pass explicitly
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{SHADE_API_URL}/api/key-management/get_key",
            json=body,
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
    
# ────────────────────────
# REST Exposer
# ────────────────────────

def expose_as_rest(path: str, methods: list = ["POST"]):
    """Decorator: Registers tool for MCP AND exposes it as REST endpoint."""
    def decorator(tool_func: Callable):
        # 1. Register as normal MCP tool (with @require_auth already applied)
        mcp.tool(tool_func)  # This makes it available in chat

        # 2. Create REST handler that calls the ORIGINAL tool logic
        @mcp.custom_route(path, methods=methods)
        @wraps(tool_func)
        async def rest_handler(request: Request):
            try:
                body = await request.json()
            except:
                body = {}

            # Authenticate from REST headers
            user = get_current_user(request=request)

            # Extract args matching tool signature (skip ctx/user)
            sig = signature(tool_func)
            kwargs = {}
            for param in sig.parameters.values():
                if param.name in ("ctx", "user"):
                    continue
                default = param.default if param.default is not param.empty else None
                kwargs[param.name] = body.get(param.name, default)

            try:
                # Call ORIGINAL function (bypasses REST wrapper)
                # If @require_auth is present, it already checks user
                result = await tool_func(None, user, **kwargs)  # ctx=None (not needed)
                return JSONResponse({"result": result})
            except Exception as e:
                logger.error(f"REST {path} error: {e}")
                return JSONResponse({"error": str(e)}, status_code=500)

        return tool_func  # Return original so MCP chain continues

    return decorator

# ─────────────
# MCP Tools
# ─────────────

mcp = FastMCP(name="nova-mcp")

@mcp.tool
@require_auth
async def register_group(ctx: Context, user: dict, group_id: str) -> str:
    await call_contract(user, "register_group", {"group_id": group_id}, "register_group")
    # Shade key generation
    config = get_config(user["near_account_id"])
    headers = {"Content-Type": "application/json"}
    if user.get("wallet_id"):
        headers["Authorization"] = f"Bearer wallet:{user['wallet_id']}"
    elif user.get("access_token"):
        headers["Authorization"] = f"Bearer {user['access_token']}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        await client.post(f"{SHADE_API_URL}/api/key-management/generate_key",
                          json={"group_id": group_id, "owner": user["near_account_id"], "account_id": user["near_account_id"]},
                          headers=headers)
    return f"Group '{group_id}' registered successfully"

@mcp.tool
@require_auth
async def add_group_member(ctx: Context, user: dict, group_id: str, member_id: str) -> str:
    member_id = normalize_account_id(member_id)
    await call_contract(user, "add_group_member", {"group_id": group_id, "user_id": member_id}, "add_group_member")
    return f"Added {member_id} to group '{group_id}'"

@mcp.tool
@require_auth
async def revoke_group_member(ctx: Context, user: dict, group_id: str, member_id: str) -> str:
    member_id = normalize_account_id(member_id)
    await call_contract(user, "revoke_group_member", {"group_id": group_id, "user_id": member_id}, "revoke_group_member")
    return f"Revoked {member_id} from group '{group_id}' (key rotated)"

@mcp.tool
@require_auth
async def prepare_upload(ctx: Context, user: dict, group_id: str, filename: str) -> dict:
    cleanup_expired_uploads()
    key = await _get_shade_key_internal(group_id, user)
    upload_id = str(uuid4())
    PENDING_UPLOADS[upload_id] = {
        "group_id": group_id, "filename": filename,
        "user_id": user["near_account_id"], "user_email": user.get("email"),
        "wallet_id": user.get("wallet_id"), "access_token": user.get("access_token"),
        "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
    }
    return {"upload_id": upload_id, "key": key, "group_id": group_id, "filename": filename}

@mcp.tool
@require_auth
async def finalize_upload(ctx: Context, user: dict, upload_id: str, encrypted_data: str, file_hash: str) -> dict:
    cleanup_expired_uploads()
    if upload_id not in PENDING_UPLOADS:
        raise ValueError("Invalid or expired upload_id")
    ctx_data = PENDING_UPLOADS[upload_id]
    cid = await _ipfs_upload(encrypted_data, ctx_data["filename"], ctx_data["user_id"])
    trans_id = await call_contract(user, "record_transaction",
                                   {"group_id": ctx_data["group_id"], "user_id": ctx_data["user_id"],
                                    "file_hash": file_hash, "ipfs_hash": cid}, "record_transaction")
    del PENDING_UPLOADS[upload_id]
    return {"cid": cid, "trans_id": trans_id, "file_hash": file_hash}

@mcp.tool
@require_auth
async def prepare_retrieve(ctx: Context, user: dict, group_id: str, ipfs_hash: str) -> dict:
    key = await _get_shade_key_internal(group_id, user)
    encrypted_b64 = await _ipfs_retrieve(ipfs_hash, user["near_account_id"])
    return {"key": key, "encrypted_b64": encrypted_b64, "ipfs_hash": ipfs_hash, "group_id": group_id}

async def _group_query_tool(ctx: Context, user: dict, method: str, group_id: str | None = None) -> list:
    args = {"group_id": group_id} if group_id else {}
    raw = await view_contract(user, method, args)
    try:
        return json.loads(raw) if isinstance(raw, str) else raw or []
    except:
        return []

@mcp.tool
@require_auth
async def get_owned_groups(ctx: Context, user: dict) -> list:
    return await _group_query_tool(ctx, user, "get_owned_groups") or []

@mcp.tool
@require_auth
async def get_member_groups(ctx: Context, user: dict) -> list:
    return await _group_query_tool(ctx, user, "get_member_groups") or []

@mcp.tool
@require_auth
async def get_group_members(ctx: Context, user: dict, group_id: str) -> list:
    return await _group_query_tool(ctx, user, "get_group_members", group_id) or []

@mcp.tool
@require_auth
async def get_group_transactions(ctx: Context, user: dict, group_id: str) -> list:
    return await _group_query_tool(ctx, user, "get_transactions_for_group", group_id) or []

@mcp.tool
@require_auth
async def auth_status(ctx: Context, user: dict, group_id: str = "test_group") -> dict:
    result = {"authenticated": True, "near_account_id": user["near_account_id"], "group_id": group_id}
    if user["near_account_id"] and group_id != "default":
        try:
            config = get_config(user["near_account_id"])
            acc = Account("dummy", DUMMY_PRIVATE_KEY, config["rpc_url"])
            await acc.startup()
            auth_result = await acc.view_function(config["contract_id"], "is_authorized",
                                                  {"group_id": group_id, "user_id": user["near_account_id"]})
            result["authorized_for_group"] = auth_result.result
        except:
            result["authorized_for_group"] = False
    return result


# ────────────────────
# REST Endpoints
# ────────────────────

@expose_as_rest("/tools/register_group")
@require_auth
async def register_group(ctx: Context, user: dict, group_id: str) -> str:
    await call_contract(user, "register_group", {"group_id": group_id}, "register_group")
    config = get_config(user["near_account_id"])
    headers = {"Content-Type": "application/json"}
    if user.get("wallet_id"):
        headers["Authorization"] = f"Bearer wallet:{user['wallet_id']}"
    elif user.get("access_token"):
        headers["Authorization"] = f"Bearer {user['access_token']}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        await client.post(
            f"{SHADE_API_URL}/api/key-management/generate_key",
            json={"group_id": group_id, "owner": user["near_account_id"], "account_id": user["near_account_id"]},
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

@expose_as_rest("/tools/revoke_group_member")
@require_auth
async def revoke_group_member(ctx: Context, user: dict, group_id: str, member_id: str) -> str:
    member_id = normalize_account_id(member_id)
    await call_contract(
        user=user,
        method_name="revoke_group_member",
        args={"group_id": group_id, "user_id": member_id},
        fee_action="revoke_group_member"
    )
    return f"Revoked {member_id} from group '{group_id}' (key rotated)"

@expose_as_rest("/tools/prepare_upload")
@require_auth
async def prepare_upload(ctx: Context, user: dict, group_id: str, filename: str) -> dict:
    cleanup_expired_uploads()
    
    key = await _get_shade_key_internal(group_id, user)
    
    upload_id = str(uuid4())
    PENDING_UPLOADS[upload_id] = {
        "group_id": group_id,
        "filename": filename,
        "user_id": user["near_account_id"],
        "user_email": user.get("email"),
        "wallet_id": user.get("wallet_id"),
        "access_token": user.get("access_token"),
        "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
    }
    
    return {
        "upload_id": upload_id,
        "key": key,
        "group_id": group_id,
        "filename": filename
    }

@expose_as_rest("/tools/finalize_upload")
@require_auth
async def finalize_upload(ctx: Context, user: dict, upload_id: str, encrypted_data: str, file_hash: str) -> dict:
    cleanup_expired_uploads()
    
    if upload_id not in PENDING_UPLOADS:
        raise ValueError("Invalid or expired upload_id")
    
    if not re.match(r'^[a-f0-9]{64}$', file_hash, re.IGNORECASE):
        raise ValueError("file_hash must be 64-char hex (SHA-256)")
    
    ctx_data = PENDING_UPLOADS[upload_id]
    
    # Security: verify caller owns this upload
    if ctx_data["user_id"] != user["near_account_id"]:
        raise ValueError("Account mismatch - you do not own this upload")
    
    cid = await _ipfs_upload(encrypted_data, ctx_data["filename"], ctx_data["user_id"])
    
    trans_id = await call_contract(
        user=user,
        method_name="record_transaction",
        args={
            "group_id": ctx_data["group_id"],
            "user_id": ctx_data["user_id"],
            "file_hash": file_hash,
            "ipfs_hash": cid
        },
        fee_action="record_transaction"
    )
    
    del PENDING_UPLOADS[upload_id]
    
    return {
        "cid": cid,
        "trans_id": trans_id,
        "file_hash": file_hash
    }

@expose_as_rest("/tools/prepare_retrieve")
@require_auth
async def prepare_retrieve(ctx: Context, user: dict, group_id: str, ipfs_hash: str) -> dict:
    if not ipfs_hash.startswith('Qm') and not ipfs_hash.startswith('bafy'):
        raise ValueError(f"Invalid CID format: {ipfs_hash}")
    
    key = await _get_shade_key_internal(group_id, user)
    encrypted_b64 = await _ipfs_retrieve(ipfs_hash, user["near_account_id"])
    
    return {
        "key": key,
        "encrypted_b64": encrypted_b64,
        "ipfs_hash": ipfs_hash,
        "group_id": group_id
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
            config = get_config(user["near_account_id"])
            acc = Account("dummy", DUMMY_PRIVATE_KEY, config["rpc_url"])
            await acc.startup()
            auth_result = await acc.view_function(
                config["contract_id"],
                "is_authorized",
                {"group_id": group_id, "user_id": user["near_account_id"]}
            )
            result["authorized_for_group"] = auth_result.result
        except Exception as e:
            result["authorized_for_group"] = False
            result["auth_error"] = str(e)
    
    return result

@expose_as_rest("/tools/get_owned_groups")
@require_auth
async def get_owned_groups(ctx: Context, user: dict) -> list:
    return await _group_query_tool(ctx, user, "get_owned_groups") or []

@expose_as_rest("/tools/get_member_groups")
@require_auth
async def get_member_groups(ctx: Context, user: dict) -> list:
    return await _group_query_tool(ctx, user, "get_member_groups") or []

@expose_as_rest("/tools/get_group_members")
@require_auth
async def get_group_members(ctx: Context, user: dict, group_id: str) -> list:
    return await _group_query_tool(ctx, user, "get_group_members", group_id) or []

@expose_as_rest("/tools/get_group_transactions")
@require_auth
async def get_group_transactions(ctx: Context, user: dict, group_id: str) -> list:
    return await _group_query_tool(ctx, user, "get_transactions_for_group", group_id) or []

# ─────────────────
# Custom Routes 
# ─────────────────

@mcp.custom_route("/", methods=["GET"])
async def health(request: Request):
    return JSONResponse({"status": "MCP ready", "version": "0.4.1", "auth": "enabled"})

@mcp.custom_route("/unsubscribe", methods=["GET"])
async def unsubscribe_route(request: Request):
    email = request.query_params.get("email")
    token = request.query_params.get("token")
    if not email:
        return JSONResponse({"error": "Missing email"}, status_code=400)
    
    expected = hashlib.sha256(f"{email}:{SESSION_TOKEN_SECRET}".encode()).hexdigest()[:16]
    if token != expected:
        return JSONResponse({"error": "Invalid token"}, status_code=403)
    
    if unsubscribe_user(email):
        return JSONResponse({
            "success": True,
            "message": "You've been unsubscribed. You won't receive any more emails from NOVA."
        })
    return JSONResponse({"error": "Email not found"}, status_code=404)

@mcp.custom_route("/auth/callback", methods=["GET"])
async def auth_callback(request: Request):
    # Your existing OAuth logic here (unchanged)
    pass

# ────────────────────
# CORS & Expose App
# ────────────────────

mcp.app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(.*\.)?(nova-sdk\.com|localhost)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = mcp.app
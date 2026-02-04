# NOVA-mcp: w/ unified account architecture (email + wallet users), automated signing from Shade TEE, and self-supported fees.
import os
import sqlite3
import json
import hashlib
import re
import time
from typing import Optional, Dict, Any
import logging
from contextlib import contextmanager
from wsgiref import headers
from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
import asyncio
import base64
from uuid import uuid4
# Crypto/NEAR imports
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.backends import default_backend
import base58
import py_near
from py_near.account import Account
from dotenv import load_dotenv
from fastmcp import FastMCP, Context
from fastmcp.server.auth import RemoteAuthProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier
from fastmcp.server.dependencies import get_http_headers
import httpx
import uvicorn
import jwt

# Load .env variables
load_dotenv()

# Configuration from environment variables
CONTRACT_ID = os.environ.get("CONTRACT_ID", "nova-sdk-6.testnet")
NETWORK = os.environ.get("NETWORK", "").lower()
if not NETWORK:
    if "testnet" in CONTRACT_ID or CONTRACT_ID.endswith(".testnet"):
        NETWORK = "testnet"
    elif CONTRACT_ID.endswith(".near"):
        NETWORK = "mainnet"
    else:
        NETWORK = "testnet"
IS_TESTNET = NETWORK == "testnet"
SHADE_API_URL = os.environ.get("SHADE_API_URL", "")
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "")
if not AUTH0_DOMAIN:
    raise ValueError("AUTH0_DOMAIN env var required")
AUTH0_AUDIENCE = os.environ.get("AUTH0_AUDIENCE", "https://nova-mcp.fastmcp.app")
AUTH0_ISSUER = os.environ.get("AUTH0_ISSUER", "")
AUTH0_CLIENT_ID = os.environ.get("AUTH0_CLIENT_ID")
AUTH0_CLIENT_SECRET = os.environ.get("AUTH0_CLIENT_SECRET")
if not (AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET):
    raise ValueError("AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET env vars required")
RPC_URL = os.environ.get("RPC_URL", "https://rpc.testnet.near.org")
PINATA_GATEWAY = os.environ.get("PINATA_GATEWAY", "")
IPFS_API_KEY = os.environ.get("IPFS_API_KEY", "")
IPFS_API_SECRET = os.environ.get("IPFS_API_SECRET", "")
if not IS_TESTNET and not (IPFS_API_KEY and IPFS_API_SECRET):
    raise ValueError("IPFS_API_KEY and IPFS_API_SECRET env vars required for mainnet")
RELAYER_URL = os.environ.get("RELAYER_URL", "https://relayer.testnet.near.org")
DUMMY_PRIVATE_KEY = "ed25519:" + "A" * 86 # for view-only NEAR RPC calls
SESSION_TOKEN_SECRET = os.environ.get("SESSION_TOKEN_SECRET")
if not SESSION_TOKEN_SECRET:
    raise ValueError("SESSION_TOKEN_SECRET env var required")
SESSION_TOKEN_ISSUER = "https://nova-sdk.com"
SESSION_TOKEN_AUDIENCE = "https://nova-mcp.fastmcp.app"
ACCOUNT_SUFFIX = os.environ.get("ACCOUNT_SUFFIX", ".nova-sdk-6.testnet")

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Log network mode on startup
logger.info(f"🌐 NOVA MCP Server starting in {NETWORK.upper()} mode")
logger.info(f"   Contract: {CONTRACT_ID}")
if IS_TESTNET:
    logger.info(f"   ⚠️  TESTNET MODE: IPFS operations are MOCKED")

# Temporary storage for pending uploads
PENDING_UPLOADS: Dict[str, Dict[str, Any]] = {}
UPLOAD_EXPIRY_SECONDS = 300  # 5 minutes

def cleanup_expired_uploads():
    """Remove expired upload IDs."""
    now = time.time()
    expired = [uid for uid, data in PENDING_UPLOADS.items() if data.get("expires_at", 0) < now]
    for uid in expired:
        del PENDING_UPLOADS[uid]

# Testnet mock storage (in-memory, simulates IPFS)
TESTNET_MOCK_FILES: Dict[str, Dict[str, Any]] = {}

def generate_mock_cid(data: bytes, filename: str) -> str:
    """Generate a realistic-looking mock CID for testnet."""
    content_hash = hashlib.sha256(data + filename.encode()).hexdigest()
    return f"Qm{content_hash[:44]}"

# SQLite context manager
@contextmanager
def get_db():
    conn = sqlite3.connect('nova-users.db', check_same_thread=False)
    try:
        yield conn
    finally:
        conn.close()

# Init DB (run once)
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

def normalize_account_id(account_id: str) -> str:
    """
    Auto-append NOVA suffix if user provides just a username.
    
    Examples:
        "john" → "john.nova-sdk-6.testnet"
        "alice" → "alice.nova-sdk-6.testnet"
        "bob.near" → "bob.near" (unchanged - external account)
        "carol.testnet" → "carol.testnet" (unchanged - external account)
        "dave.nova-sdk-6.testnet" → "dave.nova-sdk-6.testnet" (unchanged - already complete)
    """
    if not account_id:
        raise ValueError("Account ID cannot be empty")
    
    # Clean up whitespace
    account_id = account_id.strip().lower()
    
    # If it already contains a dot, assume it's a full account ID
    if '.' in account_id:
        return account_id
    
    # Validate username format (NEAR account rules)
    if not re.match(r'^[a-z0-9_-]{2,64}$', account_id):
        raise ValueError(f"Invalid username format: {account_id}")
    
    # Append the NOVA suffix
    full_account_id = f"{account_id}{ACCOUNT_SUFFIX}"
    logger.info(f"Auto-completed account ID: {account_id} → {full_account_id}")
    
    return full_account_id

def store_user(email: str = None, near_account_id: str = None) -> int:
    """Store user at account creation. Email is optional (wallet users may not have one)."""
    if not email and not near_account_id:
        raise ValueError("Need either email or near_account_id")
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        if email:
            # Upsert by email
            cursor.execute("""
                INSERT INTO users (email, near_account_id) 
                VALUES (?, ?)
                ON CONFLICT(email) DO UPDATE SET 
                    near_account_id = COALESCE(excluded.near_account_id, users.near_account_id)
            """, (email, near_account_id))
        else:
            # Insert wallet-only user
            cursor.execute(
                "INSERT OR IGNORE INTO users (near_account_id) VALUES (?)",
                (near_account_id,)
            )
        
        conn.commit()
        return cursor.lastrowid


def get_marketing_emails() -> list:
    """Get all emails that haven't unsubscribed (for your marketing scripts)."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT email FROM users WHERE email IS NOT NULL AND unsubscribed = FALSE"
        )
        return [row[0] for row in cursor.fetchall()]


def unsubscribe_user(email: str) -> bool:
    """Called from unsubscribe link in emails."""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE users SET unsubscribed = TRUE WHERE email = ?",
            (email,)
        )
        conn.commit()
        return cursor.rowcount > 0
    
def generate_unsubscribe_link(email: str) -> str:
    """Generate a signed unsubscribe link for email footers."""
    token = hashlib.sha256(f"{email}:{SESSION_TOKEN_SECRET}".encode()).hexdigest()[:16]
    from urllib.parse import quote
    return f"https://nova-mcp.fastmcp.app/unsubscribe?email={quote(email)}&token={token}"

# Auth0 JWT Verifier (generic OIDC)
token_verifier = JWTVerifier(
    jwks_uri=f"https://{AUTH0_DOMAIN}/.well-known/jwks.json" if AUTH0_DOMAIN else None,
    issuer=AUTH0_ISSUER if AUTH0_DOMAIN else None,
    audience=AUTH0_AUDIENCE
)

# RemoteAuthProvider (OIDC for Auth0)
auth_provider = RemoteAuthProvider(
    token_verifier=token_verifier,
    authorization_servers=[AUTH0_ISSUER] if AUTH0_DOMAIN else [],
    base_url="https://nova-mcp.fastmcp.app"
) if AUTH0_DOMAIN else None

# define middleware for authentication
async def auth_middleware(ctx: Context):
    token = ctx.token or ""
    headers = get_http_headers()
    
    # 1: Wallet users (no auth0 jwt)
    if token.startswith("wallet:"):
        wallet_id = token[7:]  # strip "wallet:"
        if not wallet_id:
            raise ValueError("Invalid wallet token")
        ctx.state.user = {
            "wallet_id": wallet_id,
            "session_token": f"wallet_{wallet_id}",
            "near_account_id": headers.get("x-account-id"),  # NOVA account
            "email": None,
        }
        logger.info(f"Wallet user authenticated: {wallet_id}")
        return
    
    # 2: Email users (Auth0 JWT)
    if not token:
        raise ValueError("Missing auth token")
    
    try:
        claims = auth_provider.token_verifier.verify(token)
        email = claims.get("email")
        session_token = claims.get("sub")
        near_account_id = claims.get("near_account_id", claims.get("near"))  # From callback
        
        if not email:
            raise ValueError("No email in token")
        
        ctx.state.user = {
            "email": email,
            "session_token": session_token,
            "near_account_id": near_account_id or headers.get("x-account-id"),
        }
        logger.info(f"Email user authenticated: {email}")
    except Exception as e:
        logger.error(f"Auth middleware error: {e}")
        raise ValueError(f"Invalid token: {str(e)}")

# Initialize FastMCP server
mcp = FastMCP(name="nova-mcp")

# Use @mcp.route for custom HTTP endpoint
@mcp.custom_route("/", methods=["GET"])
async def mcp_health(request: Request):
    return JSONResponse({
        "status": "MCP ready", 
        "version": "0.3.1", 
        "network": NETWORK,
        "contract": CONTRACT_ID,
        "testnet_mode": IS_TESTNET,
        "auth": "enabled"
    })

# Simple unsubscribe endpoint (add to your MCP routes)
@mcp.custom_route("/unsubscribe", methods=["GET"])
async def unsubscribe_route(request: Request):
    """Handles unsubscribe links from emails: /unsubscribe?email=user@example.com&token=xyz"""
    email = request.query_params.get("email")
    token = request.query_params.get("token")
    
    if not email:
        return JSONResponse({"error": "Missing email"}, status_code=400)
    
    # Verify token (simple HMAC to prevent abuse)
    expected_token = hashlib.sha256(f"{email}:{SESSION_TOKEN_SECRET}".encode()).hexdigest()[:16]
    if token != expected_token:
        return JSONResponse({"error": "Invalid token"}, status_code=403)
    
    if unsubscribe_user(email):
        return JSONResponse({
            "success": True, 
            "message": "You've been unsubscribed. You won't receive any more emails from NOVA."
        })
    else:
        return JSONResponse({"error": "Email not found"}, status_code=404)
    

@mcp.custom_route("/auth/callback", methods=["GET"])
async def auth_callback(request: Request):
    code = request.query_params.get("code")
    if not code:
        raise HTTPException(status_code=400, detail="Missing auth code")
    
    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
        token_resp = await client.post(
            f"https://{AUTH0_DOMAIN}/oauth/token",
            data={
                "grant_type": "authorization_code",
                "client_id": AUTH0_CLIENT_ID,
                "client_secret": AUTH0_CLIENT_SECRET,
                "code": code,
                "redirect_uri": "https://nova-sdk.com/callback"
            }
        )
        token_resp.raise_for_status()
        token_data = token_resp.json()
    
    id_token = token_data["id_token"]
    try:
        claims = auth_provider.token_verifier.verify(id_token)  # Handles expiry/DCR
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Token verification failed: {str(e)}")
    
    email = claims.get("email")
    near_account_id = claims.get("near_account_id")
    
    if not email:
        raise HTTPException(status_code=400, detail="No email in claims")
    
    store_user(email=email, near_account_id=near_account_id)
    logger.info(f"User stored: {email}")
    
    # Redirect back to frontend
    return RedirectResponse(
        url=f"https://nova-sdk.com?token={id_token}",
        status_code=302
    )

# Automated signing in MCP - Fetches key from Shade TEE
async def get_user_signer(near_account_id: str, user_email: str = None, wallet_id: str = None, access_token: str = None) -> Account:
    """
    Fetches user's private key from Shade TEE and returns a signing Account.
    Works for both email users and wallet users.
    """
    if not near_account_id:
        raise ValueError("near_account_id required")
    
    if not user_email and not wallet_id and not near_account_id:
        raise ValueError("Either user_email or wallet_id required for Shade key retrieval")

    if not SHADE_API_URL:
        raise ValueError("SHADE_API_URL not configured")
    
    # Build Shade API request
    shade_payload = {}

    # ONLY send email + access token for email users
    if user_email and access_token:
        shade_payload["email"] = user_email
        shade_payload["auth_token"] = access_token
    # For wallet users, use account_id lookup
    elif wallet_id:
        shade_payload["account_id"] = near_account_id
    # For API key users (no email, no wallet_id), use account_id lookup
    elif near_account_id:
        shade_payload["account_id"] = near_account_id
    else:
        raise ValueError("Need either (email + auth_token), wallet_id, or account_id")      
    
    logger.info(f"Fetching signing key from Shade TEE for: email={user_email}, wallet_id={wallet_id}, account_id={near_account_id}")
    
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            resp = await client.post(
                f"{SHADE_API_URL}/api/user-keys/retrieve",
                json=shade_payload,
                headers={"Content-Type": "application/json"}
            )

            if resp.status_code == 404:
                raise ValueError(
                    "No NOVA account found. Please create an account at nova-sdk.com first."
                )
            
            if resp.status_code != 200:
                error_text = resp.text[:200]
                logger.error(f"Shade key retrieval failed: {resp.status_code} - {error_text}")
                raise ValueError(f"Failed to retrieve key from Shade: {resp.status_code}")
            
            data = resp.json()
            private_key = data.get("private_key")
            shade_account_id = data.get("near_account_id")
            
            if not private_key:
                raise ValueError("No private_key in Shade response")
            
            # Verify account IDs match (security check)
            if shade_account_id and shade_account_id != near_account_id:
                logger.warning(
                    f"Account ID mismatch: requested={near_account_id}, "
                    f"shade={shade_account_id}. Using Shade account."
                )
                near_account_id = shade_account_id

            logger.info(f"Retrieved private key from Shade TEE for {user_email}")
            
    except httpx.TimeoutException:
        logger.error("Shade TEE request timed out")
        raise ValueError("Key retrieval timed out - please try again")
    except httpx.RequestError as e:
        logger.error(f"Shade TEE request failed: {e}")
        raise ValueError(f"Failed to connect to secure key storage: {str(e)}")
    
    # Create Account with real private key
    try:
        acc = Account(near_account_id, private_key, RPC_URL)
        await acc.startup()
        logger.info(f"Signing account ready: {near_account_id}")
        return acc
    except Exception as e:
        logger.error(f"Failed to initialize Account: {e}")
        raise ValueError(f"Failed to initialize signing account: {str(e)}")

def _validate_near_key(private_key: str) -> str:
    """Light validation: base58, with optional ed25519: prefix."""
    if not private_key:
        raise ValueError("Invalid NEAR private_key: Empty key provided.")
    
    # Strip prefix for validation, but preserve original
    key_to_validate = private_key
    if private_key.startswith('ed25519:'):
        key_to_validate = private_key[8:]  # Remove prefix for validation
    
    # Validate base58 format (64+ chars)
    if len(key_to_validate) < 64 or not re.match(r'^[1-9A-HJ-NP-Za-km-z]{64,}$', key_to_validate):
        raise ValueError(f"Invalid NEAR private_key: Must be base58-encoded (64+ chars). Got length: {len(key_to_validate)}")
    
    return private_key  # Return original with prefix

# Helper functions (callable internally)
def get_authenticated_user() -> dict:
    """
    Get user info from HTTP headers (FastMCP 2.x compatible).
    
    Headers expected from frontend:
    - Authorization: Bearer {access_token}
    - X-User-Email: user@example.com (for email users)
    - X-Account-Id: user.nova-sdk-6.testnet (NOVA-managed account)
    - X-Wallet-Id: user.near (for wallet users - their original wallet)
    
    Returns:
        dict with: email, wallet_id, session_token, near_account_id, access_token
    """
    headers = get_http_headers()
    user_email = headers.get("x-user-email")
    account_id = headers.get("x-account-id")
    wallet_id = headers.get("x-wallet-id")
    auth_header = headers.get("authorization", "")
    
    # Check for SDK session token (nova-sdk-js/rs clients)
    if auth_header.startswith("Bearer ") and SESSION_TOKEN_SECRET:
        token = auth_header[7:]
        try:
            payload = verify_sdk_session_token(token)
            verified_account_id = payload.get("account_id")
            claimed_account_id = headers.get("x-account-id")
            
            # Security: Verify claimed account matches JWT
            if claimed_account_id and claimed_account_id != verified_account_id:
                logger.warning(f"SDK account mismatch: claimed={claimed_account_id}, token={verified_account_id}")
                raise ValueError(f"Account ID mismatch")
            
            # Extract user type from subject
            subject = payload.get("sub", "")
            wallet_id = subject[7:] if subject.startswith("wallet|") else None
            email = subject[6:] if subject.startswith("email|") else None
            
            logger.info(f"SDK session authenticated: {verified_account_id}")
            return {
                "email": email,
                "wallet_id": wallet_id,
                "session_token": hashlib.sha256(token.encode()).hexdigest(),
                "near_account_id": verified_account_id,
                "access_token": token,
            }
        except ValueError:
            # Not a valid SDK token - fall through to existing auth
            pass

    # check for nova-sdk.com session token
    if not account_id:
        raise ValueError("Missing X-Account-Id header - user not connected")

    # Extract token
    access_token = None
    if auth_header.startswith("Bearer "):
        access_token = auth_header[7:]
    
    if not user_email and not wallet_id:
        raise ValueError("Auth required: missing X-User-Email or X-Wallet-Id header")
    
    # For wallet users: email is fake, but we don't need it
    identifier = wallet_id or user_email or account_id
    session_token = hashlib.sha256(f"{identifier}:{access_token or 'wallet-only'}".encode()).hexdigest()

    return {
        "email": user_email or None,
        "wallet_id": wallet_id or None,
        "session_token": session_token,
        "near_account_id": account_id,
        "access_token": access_token,
    }

def verify_sdk_session_token(token: str) -> dict:
    """
    Verify JWT session token from nova-sdk-js (third-party dApps).
    Returns payload with account_id if valid, raises on invalid.
    """
    if not SESSION_TOKEN_SECRET:
        raise ValueError("SDK session tokens not configured on this server")
    
    try:
        payload = jwt.decode(
            token,
            SESSION_TOKEN_SECRET,
            algorithms=["HS256"],
            issuer=SESSION_TOKEN_ISSUER,
            audience=SESSION_TOKEN_AUDIENCE,
        )
        
        if payload.get("type") != "nova_session":
            raise ValueError("Invalid token type")
        
        if not payload.get("account_id"):
            raise ValueError("Token missing account_id")
        
        return payload
        
    except jwt.ExpiredSignatureError:
        raise ValueError("Session token expired. Refresh at nova-sdk.com")
    except jwt.InvalidTokenError as e:
        raise ValueError(f"Invalid session token: {str(e)}")

async def _get_shade_key(group_id: str, user_id: str, payload_b64: str, sig_hex: str, user_email: str = None, wallet_id: str = None, access_token: str = None) -> str:
    """
    Retrieves encryption key from Shade TEE for a group.
    
    Args:
        group_id: The group to get encryption key for
        user_id: NOVA-managed account ID
        contract_id: NOVA contract ID
        session_token: Session token hash
        payload_b64: Base64-encoded signed payload
        sig_hex: Hex-encoded Ed25519 signature
        user_email: Email (for email users)
        wallet_id: Original wallet ID (for wallet users)
        access_token: Auth0 JWT token
    
    Returns:
        Base64-encoded encryption key
    """
    # Get user's signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=user_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )

    contract_id = CONTRACT_ID
    
    # Determine auth method: token-based or account_id-based
    use_token_auth = (
        payload_b64 and sig_hex and
        payload_b64.lower() != "auto" and sig_hex.lower() != "auto" and
        payload_b64 != "None" and sig_hex != "None" and
        len(sig_hex) == 128 and 
        re.match(r'^[0-9a-fA-F]{128}$', sig_hex)
    )
    
    if use_token_auth:
        logger.info(f"Using pre-signed token for {user_id}")
        request_body = {"group_id": group_id, "token": f"{payload_b64}.{sig_hex}", "contract_id": CONTRACT_ID}
    else:
        # Fall back to account_id auth (for wallet users or invalid signatures)
        logger.info(f"Using account_id auth for {user_id}")
        request_body = {"group_id": group_id, "account_id": user_id, "contract_id": CONTRACT_ID}
    
    # Fetch encryption key from Shade key-management API
    async with httpx.AsyncClient() as client:
        shade_response = await client.post(
            f"{SHADE_API_URL}/api/key-management/get_key",
            json=request_body,
            timeout=15
        )
        
        if shade_response.status_code != 200:
            error_text = shade_response.text[:200]
            logger.error(f"Shade API error: {shade_response.status_code} - {error_text}")
            raise Exception(f"Shade key fetch failed: {error_text}")
        
        shade_data = shade_response.json()
    
    key = shade_data.get("key")
    checksum = shade_data.get("checksum")
    
    if not key or not checksum:
        raise Exception("Invalid Shade response: missing key or checksum")
    
    logger.info(f"Retrieved encryption key for {group_id}/{user_id}")
    return key
    
async def _group_contains_key(group_id: str, contract_id: str) -> bool:
    """Internal: Check if group exists (view)."""
    rpc = os.environ["RPC_URL"]
    contract_id = os.environ["CONTRACT_ID"]
    private_key = DUMMY_PRIVATE_KEY  # Dummy
    acc = Account("dummy", private_key, rpc)  # Dummy for view
    await acc.startup()
    result = await acc.view_function(
        contract_id=contract_id,
        method_name="group_contains_key",
        args={"group_id": group_id}
    )
    return result.result

async def _is_authorized(group_id: str, user_id: str, contract_id: str) -> bool:
    """Internal: Check authorization (view)."""
    rpc = os.environ["RPC_URL"]
    contract_id = os.environ["CONTRACT_ID"]
    private_key = DUMMY_PRIVATE_KEY  # Dummy
    acc = Account(user_id, private_key, rpc)
    await acc.startup()
    result = await acc.view_function(
        contract_id=contract_id,
        method_name="is_authorized",
        args={"group_id": group_id, "user_id": user_id}
    )
    return result.result

async def _ipfs_upload(encrypted_b64: str, filename: str) -> str:
    """Upload to IPFS via Pinata. On TESTNET: Returns mock CID."""
    encrypted_data = base64.b64decode(encrypted_b64)
    
    # TESTNET MOCK: Store locally and return fake CID
    if IS_TESTNET:
        mock_cid = generate_mock_cid(encrypted_data, filename)
        TESTNET_MOCK_FILES[mock_cid] = {
            "data": encrypted_b64,
            "filename": filename,
            "uploaded_at": time.time(),
            "size": len(encrypted_data),
        }
        logger.info(f"[TESTNET MOCK] Uploaded {filename} -> {mock_cid} ({len(encrypted_data)} bytes)")
        return mock_cid
    
    # MAINNET: Real Pinata upload
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        files = {"file": (filename, encrypted_data)}
        headers = {
            "pinata_api_key": IPFS_API_KEY,
            "pinata_secret_api_key": IPFS_API_SECRET,
            "User-Agent": "NovaMCP/1.0"
        }
        resp = await client.post(
            "https://api.pinata.cloud/pinning/pinFileToIPFS",
            headers=headers,
            files=files
        )
        resp.raise_for_status()
        cid = resp.json()["IpfsHash"]
        logger.debug(f"Uploaded {filename} -> {cid}")
        return cid

async def _ipfs_retrieve(cid: str) -> str:
    # TESTNET MOCK: Retrieve from local storage
    if IS_TESTNET:
        if cid in TESTNET_MOCK_FILES:
            mock_data = TESTNET_MOCK_FILES[cid]
            logger.info(f"[TESTNET MOCK] Retrieved {cid} ({mock_data['size']} bytes)")
            return mock_data["data"]
        else:
            logger.warning(f"[TESTNET MOCK] CID {cid} not found, returning placeholder")
            placeholder = base64.b64encode(f"TESTNET_MOCK_DATA_FOR_{cid}".encode()).decode()
            return placeholder
    
    # MAINNET: Real IPFS retrieval
    gateway = PINATA_GATEWAY.rstrip('/') if PINATA_GATEWAY else "https://gateway.pinata.cloud/ipfs"
    url = f"{gateway}/{cid.lstrip('/').strip()}"
    if not cid.startswith('Qm'):
        raise ValueError(f"Invalid CID: {cid}")
    
    headers = {'User-Agent': 'NovaMCP/1.0 (Mozilla/5.0)'}
    max_retries = 5
    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
        for attempt in range(max_retries):
            try:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                content = base64.b64encode(resp.content).decode('utf-8')
                logger.debug(f"Retrieved {cid} ({len(resp.content)} bytes)")
                return content
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    await asyncio.sleep(10 * (2 ** attempt))
                    continue
                logger.warning(f"IPFS error {e.response.status_code} on attempt {attempt+1}: {e.response.text[:100]}")
                raise ValueError(f"IPFS error {e.response.status_code}: {e.response.text[:100]}")
            except Exception as e:
                if attempt < max_retries - 1:
                    await asyncio.sleep(5 * (attempt + 1))
                    continue
                # Fallback
                fallback_url = f"https://ipfs.io/ipfs/{cid}"
                resp = await client.get(fallback_url, headers=headers)
                resp.raise_for_status()
                content = base64.b64encode(resp.content).decode('utf-8')
                logger.info(f"Fallback retrieve from ipfs.io: {cid}")
                return content
    raise ValueError(f"IPFS failed after {max_retries} retries (CID: {cid})")

async def _record_near_transaction(group_id: str, user_id: str, file_hash: str, ipfs_hash: str, user_email: str = None, wallet_id: str = None, access_token: str = None) -> str:
    """
    Records a file transaction on the NOVA contract.
    
    Uses user's signing key from Shade TEE.
    """
    contract_id = CONTRACT_ID

    if not user_email and not wallet_id and not user_id:
        raise ValueError("Either user_email or wallet_id required")
    
    if not user_id:
        raise ValueError("user_id (NEAR account) required")

    # Get user's signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=user_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee for the transaction
    fee = await _estimate_fee("record_transaction")
    gas_margin = 100_000_000_000_000
    total_attach = fee + gas_margin

    logger.info(f"Submitting record tx for {user_id} (est fee: {fee / 1e24:.4f} NEAR)")
    
    # Call the contract
    try:
        result = await acc.function_call(
            contract_id=contract_id,
            method_name="record_transaction",
            args={
                "group_id": group_id,
                "user_id": user_id,
                "file_hash": file_hash,
                "ipfs_hash": ipfs_hash
            },
            amount=total_attach,
            gas=100_000_000_000_000  # 100 TGas
        )
    
        # Handle py_near TransactionResult object
        if hasattr(result, 'status'):
            status = result.status
        elif isinstance(result, dict):
            status = result.get("status", str(result))
        else:
            status = str(result)
        
        # Check for success
        if isinstance(status, dict) and "SuccessValue" in status:
            success_value = status["SuccessValue"]
            if success_value:
                trans_id = base64.b64decode(success_value).decode()
            else:
                trans_id = hashlib.sha256(f"{group_id}{user_id}{file_hash}{ipfs_hash}".encode()).hexdigest()[:16]
        elif hasattr(result, 'transaction') and hasattr(result.transaction, 'hash'):
            # py_near TransactionResult has transaction.hash
            trans_id = result.transaction.hash
        elif hasattr(result, 'transaction_outcome'):
            # Alternative: use transaction_outcome.id
            trans_id = result.transaction_outcome.id
        else:
            # Fallback: generate a hash as ID
            trans_id = hashlib.sha256(f"{group_id}{user_id}{file_hash}{ipfs_hash}{time.time()}".encode()).hexdigest()[:16]
            logger.info(f"Using generated trans_id: {trans_id}")
        
        logger.info(f"Recorded tx: {trans_id}")
        return trans_id
            
    except httpx.TimeoutException:
        raise ValueError("Transaction timeout: Try again later")
    except Exception as e:
        logger.error(f"Transaction submission error: {e}")
        raise ValueError(f"Record failed: {str(e)}")
    
async def _estimate_fee(action: str) -> int:
    """Queries contract for fee yoctoNEAR."""
    contract_id = os.environ["CONTRACT_ID"]
    # Use dummy key for view-only calls
    acc = Account("dummy.near", DUMMY_PRIVATE_KEY, RPC_URL)
    await acc.startup()

    result = await acc.view_function(
        contract_id=contract_id,
        method_name="estimate_fee",
        args={"action": action}
    )
    return int(result.result)

async def _get_dynamic_fee(contract_id: str, action: str, file_size_gb: float = 0.0) -> int:
    """Placeholder for dynamic fee calc (e.g., USD-equiv + IPFS/GB via Chainlink oracle).
    
    TODO: Integrate Chainlink CCIP on NEAR:
    - Deploy oracle contract (e.g., for NEAR/USD feed).
    - Call as view: await acc.view_function(oracle_contract, 'get_feed', {'feed': 'NEAR/USD'})
    - Calc: near_usd = feed_value; ipfs_cost_usd = 0.15 * file_size_gb  # Real Pinata 2025 rate
    - Return int(near_usd * base_rate + ipfs_cost_usd * near_usd_price) * 1e24  # To yoctoNEAR
    
    For now: Returns 0 (use static fees).
    """
    # Placeholder: Always 0 until oracle deployed
    # Example real impl (uncomment/adapt):
    # oracle_contract = os.environ.get("ORACLE_CONTRACT", "chainlink-oracle.testnet")
    # near_acc = Account("dummy", "", rpc)  # Dummy for view
    # await near_acc.startup()
    # feed_result = await near_acc.view_function(oracle_contract, "get_feed", {"feed": "NEAR/USD"})
    # near_usd = float(feed_result.result)
    # ipfs_usd = 0.15 * file_size_gb  # Real-time Pinata overage
    # dynamic_usd = near_usd * 0.01 + ipfs_usd  # E.g., 0.01 USD base + storage
    # return int(dynamic_usd * near_usd * 1e24)  # Convert to yoctoNEAR
    
    return 0  # Stub: No dynamic adjustment

# Tools for direct external use
@mcp.tool
async def ipfs_upload(data: str, filename: str) -> str:
    """Uploads encrypted data to IPFS via Pinata and returns CID."""
    return await _ipfs_upload(data, filename)

@mcp.tool
async def ipfs_retrieve(cid: str) -> str:  # Returns base64 bytes (now async)
    """Retrieves data from IPFS via Pinata gateway."""
    return await _ipfs_retrieve(cid)

# Tools for NOVA contract interaction (requires valid auth)
@mcp.tool
async def register_group(ctx: Context, group_id: str) -> str:
    """Registers new group on NOVA contract as the authenticated user (owner)."""
    
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Get signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("register_group")
    
    logger.info(f"Registering group {group_id} for {near_account_id} (fee: {fee/1e24:.4f} NEAR)")

    # Call contract
    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="register_group",
        args={"group_id": group_id},
        amount=fee,
        gas=int("300000000000000")
    )
        
    logger.info(f"Group {group_id} registered on-chain by {near_account_id}")

    # Generate encryption key in Shade TEE
    if not SHADE_API_URL:
        logger.error("SHADE_API_URL not configured - cannot generate group key")
        raise RuntimeError("Group registered but SHADE_API_URL not configured")
    
    # Build auth headers (same pattern as get_user_signer)
    shade_headers = {"Content-Type": "application/json"}
    if wallet_id:
        shade_headers["Authorization"] = f"Bearer wallet:{wallet_id}"
    elif access_token:
        shade_headers["Authorization"] = f"Bearer {access_token}"
    
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            logger.info(f"Generating encryption key in Shade TEE for group {group_id}")
            shade_response = await client.post(
                f"{SHADE_API_URL}/api/key-management/generate_key",
                json={
                    "group_id": group_id,
                    "owner": near_account_id,
                    "account_id": near_account_id,
                    "contract_id": CONTRACT_ID,
                },
                headers=shade_headers,
            )
            
            if shade_response.status_code == 200:
                logger.info(f"Encryption key generated in Shade for group {group_id}")
            else:
                error_text = shade_response.text[:200]
                logger.error(f"Shade key generation failed ({shade_response.status_code}): {error_text}")
                raise RuntimeError(f"Group registered but key generation failed: {error_text}")
                
    except httpx.TimeoutException:
        logger.error(f"Shade key generation timed out for group {group_id}")
        raise RuntimeError("Group registered but key generation timed out - try again")
    except httpx.RequestError as e:
        logger.error(f"Shade key generation request failed for group {group_id}: {e}")
        raise RuntimeError(f"Group registered but couldn't connect to Shade: {e}")
    except RuntimeError:
        raise  # Re-raise our own errors
    except Exception as e:
        logger.error(f"Unexpected Shade key generation error for group {group_id}: {e}")
        raise RuntimeError(f"Group registered but key generation failed: {e}")

    return f"Group '{group_id}' registered successfully"
        

@mcp.tool
async def add_group_member(ctx: Context, group_id: str, member_id: str) -> str:
    """Adds member to group (owner only, uses authenticated session)."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # AUTO-COMPLETE USERNAME (in case the frontend chat fails to)
    member_id = normalize_account_id(member_id)

    # Get signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("add_group_member")
    gas_margin = 300_000_000_000_000
    total_attach = fee + gas_margin
    logger.info(f"Add member {member_id} to {group_id} by {near_account_id} (est fee: {fee / 1e24:.4f} NEAR)")

    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="add_group_member",
        args={"group_id": group_id, "user_id": member_id},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    return f"Added {member_id} to group '{group_id}'"

@mcp.tool
async def revoke_group_member(ctx: Context, group_id: str, member_id: str) -> str:
    """Revokes member from group (owner only, rotates key, uses authenticated session)."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # AUTO-COMPLETE USERNAME (in case the frontend chat fails to)
    member_id = normalize_account_id(member_id)
    
    # get signer from shade tee
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,    
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("revoke_group_member")
    gas_margin = 300_000_000_000_000
    total_attach = fee + gas_margin
    logger.info(f"Revoking {member_id} from {group_id} by {near_account_id} (est fee: {fee / 1e24:.4f} NEAR)")

    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="revoke_group_member",
        args={"group_id": group_id, "user_id": member_id},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    return f"Revoked {member_id} from group '{group_id}' (key rotated)"

@mcp.tool
async def get_shade_key(ctx: Context, group_id: str, payload_b64: str, sig_hex: str, user_id: Optional[str] = None) -> str:
    """
    Retrieves encryption key for a group from Shade TEE.
    Requires pre-signed payload and signature.
    User pays claim_token fee.
    """
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    effective_user_id = user_id or near_account_id

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not effective_user_id:
        raise ValueError("No NEAR account configured")
    
    # Allow "auto" to skip signature validation (will use account_id auth in _get_shade_key)
    if sig_hex.lower() != "auto":
        # Validate signature format only if not "auto"
        if len(sig_hex) != 128 or not re.match(r'^[0-9a-fA-F]{128}$', sig_hex):
            raise ValueError("Invalid sig_hex: Must be 128-char hex (64 bytes) or 'auto'")
    
    key = await _get_shade_key(
        group_id=group_id,
        user_id=effective_user_id,
        payload_b64=payload_b64,
        sig_hex=sig_hex,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    return key


@mcp.tool
async def record_near_transaction(ctx: Context, group_id: str, user_id: str, file_hash: str, ipfs_hash: str) -> str:
    """Records file tx on NOVA contract (User pays record_transaction fee)."""
    contract_id = CONTRACT_ID

    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    effective_user_id = user_id or near_account_id

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    if not effective_user_id:
        raise ValueError("No NEAR account configured")
    
    # Delegate to helper with all user context
    try:
        return await _record_near_transaction(
            group_id=group_id,
            user_id=effective_user_id,
            file_hash=file_hash,
            ipfs_hash=ipfs_hash,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
    except Exception as e:
        logger.error(f"Record tx error for {near_account_id}: {e}")
        raise ValueError(f"Record failed: {str(e)}")
    
@mcp.tool
async def prepare_upload(ctx: Context, group_id: str, filename: str) -> dict:
    """
    Step 1 of upload: Returns encryption key and upload_id.
    Client encrypts locally, then calls finalize_upload with encrypted data.
    
    Returns:
        upload_id: Temporary ID for finalize_upload (expires in 5 min)
        key: Base64-encoded AES-256 encryption key
        group_id: Echo back for client convenience
        filename: Echo back for client convenience
    """
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete account setup first.")
    
    # Clean up expired uploads
    cleanup_expired_uploads()
    
    # Get encryption key from Shade TEE
    key = await _get_shade_key(
        group_id=group_id,
        user_id=near_account_id,
        payload_b64="auto",
        sig_hex="auto",
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Generate upload_id and store context
    upload_id = str(uuid4())
    PENDING_UPLOADS[upload_id] = {
        "group_id": group_id,
        "filename": filename,
        "user_id": near_account_id,
        "user_email": user_email,
        "wallet_id": wallet_id,
        "access_token": access_token,
        "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
    }
    
    logger.info(f"Prepared upload {upload_id} for {filename} to group {group_id}")
    
    return {
        "upload_id": upload_id,
        "key": key,
        "group_id": group_id,
        "filename": filename,
    }


@mcp.tool
async def finalize_upload(ctx: Context, upload_id: str, encrypted_data: str, file_hash: str) -> dict:
    """
    Step 2 of upload: Receives encrypted data, uploads to IPFS, records on NEAR.
    
    Args:
        upload_id: From prepare_upload
        encrypted_data: Base64-encoded encrypted file (client encrypted with key from prepare_upload)
        file_hash: SHA-256 hex hash of the PLAINTEXT (64 chars)
    
    Returns:
        cid: IPFS content ID
        trans_id: NEAR transaction ID
        file_hash: Echo back for verification
    """
    # Clean up expired uploads
    cleanup_expired_uploads()
    
    # Validate upload_id
    if upload_id not in PENDING_UPLOADS:
        raise ValueError("Invalid or expired upload_id. Call prepare_upload first.")
    
    upload_ctx = PENDING_UPLOADS[upload_id]
    
    # Validate file_hash format
    if not re.match(r'^[a-f0-9]{64}$', file_hash, re.IGNORECASE):
        raise ValueError("file_hash must be 64-char hex (SHA-256)")
    
    group_id = upload_ctx["group_id"]
    filename = upload_ctx["filename"]
    user_id = upload_ctx["user_id"]
    user_email = upload_ctx["user_email"]
    wallet_id = upload_ctx["wallet_id"]
    access_token = upload_ctx["access_token"]
    
    logger.info(f"Finalizing upload {upload_id}: {filename} to group {group_id}")
    
    try:
        # Step 1: Upload encrypted data to IPFS
        cid = await _ipfs_upload(encrypted_data, filename)
        
        # Step 2: Record transaction on NEAR
        trans_id = await _record_near_transaction(
            group_id=group_id,
            user_id=user_id,
            file_hash=file_hash,
            ipfs_hash=cid,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Clean up - remove used upload_id
        del PENDING_UPLOADS[upload_id]
        
        logger.info(f"Upload complete: CID={cid}, Trans={trans_id}")
        
        return {
            "cid": cid,
            "trans_id": trans_id,
            "file_hash": file_hash,
        }
    
    except Exception as e:
        logger.error(f"Finalize upload error: {e}")
        raise RuntimeError(f"Upload failed: {str(e)}")


@mcp.tool
async def prepare_retrieve(ctx: Context, group_id: str, ipfs_hash: str) -> dict:
    """
    One-step retrieve: Returns encryption key and encrypted data.
    Client decrypts locally.
    
    Args:
        group_id: Group the file belongs to
        ipfs_hash: IPFS CID of the encrypted file
    
    Returns:
        key: Base64-encoded AES-256 decryption key
        encrypted_b64: Base64-encoded encrypted file data
        ipfs_hash: Echo back for verification
        group_id: Echo back for verification
    """
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete account setup first.")
    
    # Validate CID format
    if not ipfs_hash.startswith('Qm') and not ipfs_hash.startswith('bafy'):
        raise ValueError(f"Invalid CID format: {ipfs_hash}")
    
    logger.info(f"Preparing retrieve for {ipfs_hash} from group {group_id}")
    
    try:
        # Get encryption key from Shade TEE
        key = await _get_shade_key(
            group_id=group_id,
            user_id=near_account_id,
            payload_b64="auto",
            sig_hex="auto",
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Fetch encrypted data from IPFS
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash)
        
        logger.info(f"Retrieved {len(encrypted_b64)} bytes for {ipfs_hash}")
        
        return {
            "key": key,
            "encrypted_b64": encrypted_b64,
            "ipfs_hash": ipfs_hash,
            "group_id": group_id,
        }
    
    except Exception as e:
        logger.error(f"Prepare retrieve error: {e}")
        raise RuntimeError(f"Retrieve failed: {str(e)}")


# Also add the HTTP endpoint for finalize_upload (frontend calls this directly)
@mcp.custom_route("/api/finalize-upload", methods=["POST"])
async def finalize_upload_endpoint(request: Request):
    """
    Direct HTTP endpoint for finalize_upload.
    Frontend calls this after encrypting locally.
    """
    headers = dict(request.headers)
    account_id = headers.get("x-account-id")
    wallet_id = headers.get("x-wallet-id")
    user_email = headers.get("x-user-email")
    
    if not account_id:
        return JSONResponse({"error": "Missing x-account-id"}, status_code=400)
    
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    upload_id = body.get("upload_id")
    encrypted_data = body.get("encrypted_data")
    file_hash = body.get("file_hash")
    
    if not all([upload_id, encrypted_data, file_hash]):
        return JSONResponse({"error": "Required: upload_id, encrypted_data, file_hash"}, status_code=400)
    
    # Clean up expired uploads
    cleanup_expired_uploads()
    
    # Validate upload_id
    if upload_id not in PENDING_UPLOADS:
        return JSONResponse({"error": "Invalid or expired upload_id"}, status_code=400)
    
    upload_ctx = PENDING_UPLOADS[upload_id]
    
    # Security check: verify account matches
    if upload_ctx["user_id"] != account_id:
        return JSONResponse({"error": "Account mismatch"}, status_code=403)
    
    # Validate file_hash format
    if not re.match(r'^[a-f0-9]{64}$', file_hash, re.IGNORECASE):
        return JSONResponse({"error": "file_hash must be 64-char hex (SHA-256)"}, status_code=400)
    
    group_id = upload_ctx["group_id"]
    filename = upload_ctx["filename"]
    user_id = upload_ctx["user_id"]
    user_email_ctx = upload_ctx["user_email"]
    wallet_id_ctx = upload_ctx["wallet_id"]
    access_token = upload_ctx["access_token"]
    
    logger.info(f"HTTP finalize upload {upload_id}: {filename} to group {group_id}")
    
    try:
        # Step 1: Upload encrypted data to IPFS
        cid = await _ipfs_upload(encrypted_data, filename)
        
        # Step 2: Record transaction on NEAR
        trans_id = await _record_near_transaction(
            group_id=group_id,
            user_id=user_id,
            file_hash=file_hash,
            ipfs_hash=cid,
            user_email=user_email_ctx,
            wallet_id=wallet_id_ctx,
            access_token=access_token
        )
        
        # Clean up
        del PENDING_UPLOADS[upload_id]
        
        logger.info(f"HTTP upload complete: CID={cid}, Trans={trans_id}")
        
        return JSONResponse({
            "cid": cid,
            "trans_id": trans_id,
            "file_hash": file_hash,
        })
    
    except Exception as e:
        logger.error(f"HTTP finalize upload error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)
    
def get_authenticated_user_from_request(request: Request) -> dict:
    """
    Get user info from request headers (for REST endpoints).
    """
    headers = dict(request.headers)
    user_email = headers.get("x-user-email")
    account_id = headers.get("x-account-id")
    wallet_id = headers.get("x-wallet-id")
    auth_header = headers.get("authorization", "")
    
    # Check for SDK session token
    if auth_header.startswith("Bearer ") and SESSION_TOKEN_SECRET:
        token = auth_header[7:]
        try:
            payload = verify_sdk_session_token(token)
            verified_account_id = payload.get("account_id")
            claimed_account_id = headers.get("x-account-id")
            
            # Security: Verify claimed account matches JWT
            if claimed_account_id and claimed_account_id != verified_account_id:
                logger.warning(f"SDK account mismatch: claimed={claimed_account_id}, token={verified_account_id}")
                raise ValueError("Account ID mismatch")
            
            # Extract user type from subject
            subject = payload.get("sub", "")
            wallet_id = subject[7:] if subject.startswith("wallet|") else None
            email = subject[6:] if subject.startswith("email|") else None
            
            logger.info(f"REST: SDK session authenticated: {verified_account_id}")
            return {
                "email": email,
                "wallet_id": wallet_id,
                "session_token": hashlib.sha256(token.encode()).hexdigest(),
                "near_account_id": verified_account_id,
                "access_token": token,
            }
        except ValueError as e:
            raise ValueError(str(e))
    
    if not account_id:
        raise ValueError("Missing X-Account-Id header - user not connected")
    
    # Extract token
    access_token = None
    if auth_header.startswith("Bearer "):
        access_token = auth_header[7:]
    
    if not user_email and not wallet_id:
        raise ValueError("Auth required: missing X-User-Email or X-Wallet-Id header")
    
    identifier = wallet_id or user_email or account_id
    session_token = hashlib.sha256(f"{identifier}:{access_token or 'wallet-only'}".encode()).hexdigest()
    
    return {
        "email": user_email or None,
        "wallet_id": wallet_id or None,
        "session_token": session_token,
        "near_account_id": account_id,
        "access_token": access_token,
    }

# ========== REST WRAPPERS FOR SDK ==========
# These endpoints allow the SDK to call MCP tools via simple REST API

@mcp.custom_route("/tools/auth_status", methods=["POST"])
async def auth_status_rest(request: Request):
    """REST wrapper for auth_status tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        body = {}
    
    group_id = body.get("group_id", "test_group")
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    near_account_id = user.get("near_account_id")
    
    result = {
        "authenticated": True,
        "email": user_email,
        "wallet_id": wallet_id,
        "near_account_id": near_account_id,
        "group_id": group_id,
    }
    
    if near_account_id and group_id != "default":
        try:
            acc = Account("dummy.near", DUMMY_PRIVATE_KEY, RPC_URL)
            await acc.startup()
            auth_result = await acc.view_function(
                contract_id=CONTRACT_ID,
                method_name="is_authorized",
                args={"group_id": group_id, "user_id": near_account_id}
            )
            result["authorized_for_group"] = auth_result.result
        except Exception as e:
            result["authorized_for_group"] = False
            result["auth_error"] = str(e)
    
    return JSONResponse(result)


@mcp.custom_route("/tools/prepare_upload", methods=["POST"])
async def prepare_upload_rest(request: Request):
    """REST wrapper for prepare_upload tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    group_id = body.get("group_id")
    filename = body.get("filename")
    
    if not group_id or not filename:
        return JSONResponse({"error": "Required: group_id, filename"}, status_code=400)
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        return JSONResponse({"error": "No NEAR account configured"}, status_code=400)
    
    try:
        # Clean up expired uploads
        cleanup_expired_uploads()
        
        # Get encryption key from Shade TEE
        key = await _get_shade_key(
            group_id=group_id,
            user_id=near_account_id,
            payload_b64="auto",
            sig_hex="auto",
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Generate upload_id and store context
        upload_id = str(uuid4())
        PENDING_UPLOADS[upload_id] = {
            "group_id": group_id,
            "filename": filename,
            "user_id": near_account_id,
            "user_email": user_email,
            "wallet_id": wallet_id,
            "access_token": access_token,
            "expires_at": time.time() + UPLOAD_EXPIRY_SECONDS,
        }
        
        logger.info(f"REST: Prepared upload {upload_id} for {filename} to group {group_id}")
        
        return JSONResponse({
            "upload_id": upload_id,
            "key": key,
            "group_id": group_id,
            "filename": filename,
        })
    
    except Exception as e:
        logger.error(f"REST prepare_upload error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/tools/prepare_retrieve", methods=["POST"])
async def prepare_retrieve_rest(request: Request):
    """REST wrapper for prepare_retrieve tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    group_id = body.get("group_id")
    ipfs_hash = body.get("ipfs_hash")
    
    if not group_id or not ipfs_hash:
        return JSONResponse({"error": "Required: group_id, ipfs_hash"}, status_code=400)
    
    # Validate CID format
    if not ipfs_hash.startswith('Qm') and not ipfs_hash.startswith('bafy'):
        return JSONResponse({"error": f"Invalid CID format: {ipfs_hash}"}, status_code=400)
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        return JSONResponse({"error": "No NEAR account configured"}, status_code=400)
    
    try:
        # Get encryption key from Shade TEE
        key = await _get_shade_key(
            group_id=group_id,
            user_id=near_account_id,
            payload_b64="auto",
            sig_hex="auto",
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Fetch encrypted data from IPFS
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash)
        
        logger.info(f"REST: Retrieved {len(encrypted_b64)} bytes for {ipfs_hash}")
        
        return JSONResponse({
            "key": key,
            "encrypted_b64": encrypted_b64,
            "ipfs_hash": ipfs_hash,
            "group_id": group_id,
        })
    
    except Exception as e:
        logger.error(f"REST prepare_retrieve error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/tools/register_group", methods=["POST"])
async def register_group_rest(request: Request):
    """REST wrapper for register_group tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    group_id = body.get("group_id")
    
    if not group_id:
        return JSONResponse({"error": "Required: group_id"}, status_code=400)
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        return JSONResponse({"error": "No NEAR account configured"}, status_code=400)
    
    try:
        # Get signing account from Shade TEE
        acc = await get_user_signer(
            near_account_id=near_account_id,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Estimate fee
        fee = await _estimate_fee("register_group")
        
        logger.info(f"REST: Registering group {group_id} for {near_account_id} (fee: {fee/1e24:.4f} NEAR)")
        
        # Call contract
        result = await acc.function_call(
            contract_id=CONTRACT_ID,
            method_name="register_group",
            args={"group_id": group_id},
            amount=fee,
            gas=int("300000000000000")
        )
        
        logger.info(f"REST: Group {group_id} registered on-chain by {near_account_id}")
        
        # Generate encryption key in Shade TEE
        if SHADE_API_URL:
            shade_headers = {"Content-Type": "application/json"}
            if wallet_id:
                shade_headers["Authorization"] = f"Bearer wallet:{wallet_id}"
            elif access_token:
                shade_headers["Authorization"] = f"Bearer {access_token}"
            
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                shade_response = await client.post(
                    f"{SHADE_API_URL}/api/key-management/generate_key",
                    json={
                        "group_id": group_id,
                        "owner": near_account_id,
                        "account_id": near_account_id,
                        "contract_id": CONTRACT_ID,
                    },
                    headers=shade_headers,
                )
                
                if shade_response.status_code != 200:
                    error_text = shade_response.text[:200]
                    logger.error(f"Shade key generation failed: {error_text}")
                    return JSONResponse({
                        "message": f"Group '{group_id}' registered but key generation failed",
                        "error": error_text
                    }, status_code=500)
        
        return JSONResponse({"message": f"Group '{group_id}' registered successfully"})
    
    except Exception as e:
        logger.error(f"REST register_group error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/tools/add_group_member", methods=["POST"])
async def add_group_member_rest(request: Request):
    """REST wrapper for add_group_member tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    group_id = body.get("group_id")
    member_id = body.get("member_id")
    
    if not group_id or not member_id:
        return JSONResponse({"error": "Required: group_id, member_id"}, status_code=400)
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        return JSONResponse({"error": "No NEAR account configured"}, status_code=400)
    
    try:
        # Auto-complete username
        member_id = normalize_account_id(member_id)
        
        # Get signing account from Shade TEE
        acc = await get_user_signer(
            near_account_id=near_account_id,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Estimate fee
        fee = await _estimate_fee("add_group_member")
        
        logger.info(f"REST: Add member {member_id} to {group_id} by {near_account_id}")
        
        result = await acc.function_call(
            contract_id=CONTRACT_ID,
            method_name="add_group_member",
            args={"group_id": group_id, "user_id": member_id},
            amount=fee,
            gas=100_000_000_000_000
        )
        
        return JSONResponse({"message": f"Added {member_id} to group '{group_id}'"})
    
    except Exception as e:
        logger.error(f"REST add_group_member error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


@mcp.custom_route("/tools/revoke_group_member", methods=["POST"])
async def revoke_group_member_rest(request: Request):
    """REST wrapper for revoke_group_member tool (SDK clients)."""
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    
    group_id = body.get("group_id")
    member_id = body.get("member_id")
    
    if not group_id or not member_id:
        return JSONResponse({"error": "Required: group_id, member_id"}, status_code=400)
    
    try:
        user = get_authenticated_user_from_request(request)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=401)
    
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        return JSONResponse({"error": "No NEAR account configured"}, status_code=400)
    
    try:
        # Auto-complete username
        member_id = normalize_account_id(member_id)
        
        # Get signing account from Shade TEE
        acc = await get_user_signer(
            near_account_id=near_account_id,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
        
        # Estimate fee
        fee = await _estimate_fee("revoke_group_member")
        
        logger.info(f"REST: Revoke member {member_id} from {group_id} by {near_account_id}")
        
        result = await acc.function_call(
            contract_id=CONTRACT_ID,
            method_name="revoke_group_member",
            args={"group_id": group_id, "user_id": member_id},
            amount=fee,
            gas=100_000_000_000_000
        )
        
        return JSONResponse({"message": f"Revoked {member_id} from group '{group_id}' (key rotated)"})
    
    except Exception as e:
        logger.error(f"REST revoke_group_member error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)

@mcp.tool
async def auth_status(ctx: Context, group_id: str = "test_group") -> dict:
    """Tool: Check user auth/groups on NOVA contract. Returns {'authorized': bool, 'groups': list[str], 'member_count': int}."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required.")
    
    result = {
        "authenticated": True,
        "email": user_email,
        "wallet_id": wallet_id,
        "near_account_id": near_account_id,
        "group_id": group_id,
    }
    
    if near_account_id and group_id != "default":
        try:
            # View-only call with dummy key
            acc = Account("dummy.near", DUMMY_PRIVATE_KEY, RPC_URL)
            await acc.startup()
            
            auth_result = await acc.view_function(
                contract_id=CONTRACT_ID,
                method_name="is_authorized",
                args={"group_id": group_id, "user_id": near_account_id}
            )
            result["authorized_for_group"] = auth_result.result
        except Exception as e:
            result["authorized_for_group"] = False
            result["auth_error"] = str(e)
    
    return result
    

async def verify_shade_checksum_for_group(group_id: str, checksum: str, contract_id: str = None) -> bool:
    """Verifies Shade attestation checksum against on-chain expected for the group."""
    contract_id = os.environ["CONTRACT_ID"]
    rpc = os.environ["RPC_URL"]
    private_key = DUMMY_PRIVATE_KEY  # Dummy for views
    acc = Account("dummy.near", private_key, rpc)  # Dummy account for view
    await acc.startup()
    try:
        # Fetch expected checksum from contract view
        checksum_result = await acc.view_function(
            contract_id=contract_id,
            method_name="get_group_checksum",
            args={"group_id": group_id}
        )
        # py_near returns result as str; handle None as empty str or explicit check
        expected_checksum = checksum_result.result if checksum_result.result else None
        if expected_checksum is None:
            print(f"No checksum set for group {group_id} (key not generated yet?)")
            return False
        # Ensure str comparison (strip whitespace if needed)
        expected_checksum = expected_checksum.strip()
        verified = expected_checksum == checksum
        print(f"Checksum verification for {group_id}: expected={expected_checksum}, provided={checksum}, match={verified}")
        return verified
    except Exception as e:
        print(f"Checksum query failed for {group_id}: {str(e)} (e.g., RPC error or contract not deployed)")
        return False
    
@mcp.tool
async def get_owned_groups(ctx: Context) -> list:
    """Returns list of groups owned by the authenticated user."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Get signing account from Shade TEE (these are payable methods)
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("get_owned_groups")
    
    logger.info(f"Fetching owned groups for {near_account_id} (fee: {fee/1e24:.6f} NEAR)")

    # Call contract (payable method)
    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="get_owned_groups",
        args={},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    # Parse result
    if hasattr(result, 'status') and isinstance(result.status, dict):
        if "SuccessValue" in result.status:
            import base64
            success_value = result.status["SuccessValue"]
            if success_value:
                decoded = base64.b64decode(success_value).decode()
                return json.loads(decoded)
    
    # Fallback: try to get result directly
    if hasattr(result, 'result'):
        return result.result
    
    return []


@mcp.tool
async def get_member_groups(ctx: Context) -> list:
    """Returns list of groups where the authenticated user is a member (includes owned groups)."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Get signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("get_member_groups")
    
    logger.info(f"Fetching member groups for {near_account_id} (fee: {fee/1e24:.6f} NEAR)")

    # Call contract (payable method)
    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="get_member_groups",
        args={},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    # Parse result
    if hasattr(result, 'status') and isinstance(result.status, dict):
        if "SuccessValue" in result.status:
            import base64
            success_value = result.status["SuccessValue"]
            if success_value:
                decoded = base64.b64decode(success_value).decode()
                return json.loads(decoded)
    
    if hasattr(result, 'result'):
        return result.result
    
    return []


@mcp.tool
async def get_group_members(ctx: Context, group_id: str) -> list:
    """Returns list of members authorized for the specified group. Caller must be a member or contract owner."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    if not group_id:
        raise ValueError("group_id is required")
    
    # Get signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("get_group_members")
    
    logger.info(f"Fetching members of group '{group_id}' for {near_account_id} (fee: {fee/1e24:.6f} NEAR)")

    # Call contract (payable method)
    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="get_group_members",
        args={"group_id": group_id},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    # Parse result
    if hasattr(result, 'status') and isinstance(result.status, dict):
        if "SuccessValue" in result.status:
            import base64
            success_value = result.status["SuccessValue"]
            if success_value:
                decoded = base64.b64decode(success_value).decode()
                return json.loads(decoded)
    
    if hasattr(result, 'result'):
        return result.result
    
    return []


@mcp.tool
async def get_group_transactions(ctx: Context, group_id: str) -> list:
    """Returns list of file transactions for the specified group. Caller must be a member or contract owner."""
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")

    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    if not group_id:
        raise ValueError("group_id is required")
    
    # Get signing account from Shade TEE
    acc = await get_user_signer(
        near_account_id=near_account_id,
        user_email=user_email,
        wallet_id=wallet_id,
        access_token=access_token
    )
    
    # Estimate fee
    fee = await _estimate_fee("get_transactions_for_group")
    
    logger.info(f"Fetching transactions for group '{group_id}' by {near_account_id} (fee: {fee/1e24:.6f} NEAR)")

    # Call contract (payable method)
    result = await acc.function_call(
        contract_id=CONTRACT_ID,
        method_name="get_transactions_for_group",
        args={"group_id": group_id},
        amount=fee,
        gas=100_000_000_000_000
    )
    
    # Parse result
    if hasattr(result, 'status') and isinstance(result.status, dict):
        if "SuccessValue" in result.status:
            import base64
            success_value = result.status["SuccessValue"]
            if success_value:
                decoded = base64.b64decode(success_value).decode()
                return json.loads(decoded)
    
    if hasattr(result, 'result'):
        return result.result
    
    return []

if __name__ == "__main__":
    mcp.run(transport="http", host="0.0.0.0", port=8000)
# NOVA-mcp: w/ unified account architecture (email + wallet users), automated signing from Shade TEE, and self-supported fees.
import os
import sqlite3
import json
import hashlib
import re
import time
from datetime import datetime
from typing import Optional, Dict, Any
import logging
from contextlib import contextmanager
from wsgiref import headers
from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse, JSONResponse
import asyncio
import base64

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
CONTRACT_ID = os.environ.get("CONTRACT_ID", "nova-sdk-5.testnet")
RPC_URL = os.environ.get("RPC_URL", "https://rpc.testnet.near.org")
PINATA_GATEWAY = os.environ.get("PINATA_GATEWAY", "")
IPFS_API_KEY = os.environ.get("IPFS_API_KEY", "")
IPFS_API_SECRET = os.environ.get("IPFS_API_SECRET", "")
if not (IPFS_API_KEY and IPFS_API_SECRET):
    raise ValueError("IPFS_API_KEY and IPFS_API_SECRET env vars required")
RELAYER_URL = os.environ.get("RELAYER_URL", "https://relayer.testnet.near.org")
DUMMY_PRIVATE_KEY = "ed25519:" + "A" * 86 # for view-only NEAR RPC calls
SESSION_TOKEN_SECRET = os.environ.get("SESSION_TOKEN_SECRET")
if not SESSION_TOKEN_SECRET:
    raise ValueError("SESSION_TOKEN_SECRET env var required")
SESSION_TOKEN_ISSUER = "https://nova-sdk.com"
SESSION_TOKEN_AUDIENCE = "https://nova-mcp.fastmcp.app"
ACCOUNT_SUFFIX = os.environ.get("ACCOUNT_SUFFIX", ".nova-sdk-5.testnet")

# Logging setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
        "john" → "john.nova-sdk-5.testnet"
        "alice" → "alice.nova-sdk-5.testnet"
        "bob.near" → "bob.near" (unchanged - external account)
        "carol.testnet" → "carol.testnet" (unchanged - external account)
        "dave.nova-sdk-5.testnet" → "dave.nova-sdk-5.testnet" (unchanged - already complete)
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
    return JSONResponse({"status": "MCP ready", "version": "0.3.0", "auth": "enabled"})

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
    
    if not user_email and not wallet_id:
        raise ValueError("Either user_email or wallet_id required for Shade key retrieval")

    if not SHADE_API_URL:
        raise ValueError("SHADE_API_URL not configured")
    
    # Build Shade API request
    shade_payload = {}

    # ONLY send email + access token for email users
    if user_email and access_token:
        shade_payload["email"] = user_email
        shade_payload["auth_token"] = access_token
    # ONLY send wallet_id for wallet users
    elif wallet_id:
        shade_payload["account_id"] = near_account_id
    else:
        raise ValueError("Need either (email + auth_token) or wallet_id")      
    
    logger.info(f"Fetching signing key from Shade TEE for: email={user_email}, wallet_id={wallet_id}")
    
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
    - X-Account-Id: user.nova-sdk-5.testnet (NOVA-managed account)
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
        payload_b64 != "None" and sig_hex != "None" and
        len(sig_hex) == 128 and 
        re.match(r'^[0-9a-fA-F]{128}$', sig_hex)
    )
    
    if use_token_auth:
        logger.info(f"Using pre-signed token for {user_id}")
        request_body = {"group_id": group_id, "token": f"{payload_b64}.{sig_hex}"}
    else:
        # Fall back to account_id auth (for wallet users or invalid signatures)
        logger.info(f"Using account_id auth for {user_id}")
        request_body = {"group_id": group_id, "account_id": user_id}
    
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

def _encrypt_data(data: str, key: str) -> str:
    """Encrypts base64 data with AES-256-CBC."""
    # Try to decode as base64 first (for binary files or pre-encoded data)
    try:
        data_bytes = base64.b64decode(data, validate=True)
    except Exception:
        # Fall back to UTF-8 encoding for raw text
        data_bytes = data.encode('utf-8')

    key_bytes = base64.b64decode(key)[:32]
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    pad_len = 16 - (len(data_bytes) % 16)
    padded = data_bytes + bytes([pad_len] * pad_len)
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(iv + encrypted).decode('utf-8')

def _decrypt_data(encrypted: str, key: str) -> str:
    """Decrypts base64 encrypted data with AES-256-CBC."""
    encrypted_bytes = base64.b64decode(encrypted)
    if len(encrypted_bytes) < 16:
        raise ValueError(f"Invalid encrypted data length: {len(encrypted_bytes)} (must be >=16 for IV)")
    key_bytes = base64.b64decode(key)[:32]
    iv = encrypted_bytes[:16]
    ciphertext = encrypted_bytes[16:]
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    decryptor = cipher.decryptor()
    decrypted_padded = decryptor.update(ciphertext) + decryptor.finalize()
    pad_len = decrypted_padded[-1]
    decrypted = decrypted_padded[:-pad_len]
    return base64.b64encode(decrypted).decode('utf-8')

async def _ipfs_upload(encrypted_b64: str, filename: str) -> str:
    """Upload to IPFS via Pinata."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        encrypted_data = base64.b64decode(encrypted_b64)
        files = {"file": (filename, encrypted_data)}
        headers = {
            "pinata_api_key": IPFS_API_KEY,
            "pinata_secret_api_key": IPFS_API_SECRET,
            "User-Agent": "NovaMCP/1.0"  # Pinata 2025 compliance
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

    if not user_email and not wallet_id:
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
    data_bytes = base64.b64decode(data)
    url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
    headers = {
        "pinata_api_key": os.environ["IPFS_API_KEY"],
        "pinata_secret_api_key": os.environ["IPFS_API_SECRET"]
    }
    files = {"file": (filename, data_bytes)}
    async with httpx.AsyncClient() as client:
        response = await client.post(url, headers=headers, files=files)
        if response.status_code == 200:
            return response.json()["IpfsHash"]
        raise Exception(f"Upload failed: {response.text}")

@mcp.tool
async def ipfs_retrieve(cid: str) -> str:  # Returns base64 bytes (now async)
    """Retrieves data from IPFS via Pinata gateway."""
    return await _ipfs_retrieve(cid)

@mcp.tool
def encrypt_data(data: str, key: str) -> str:  # Input b64 data/key; return b64 encrypted
    """Encrypts base64 data with AES-CBC key (32 bytes padded)."""
    return _encrypt_data(data, key)

@mcp.tool
def decrypt_data(encrypted: str, key: str) -> str:  # b64 in/out
    """Decrypts base64 encrypted data with AES-CBC key."""
    return _decrypt_data(encrypted, key)

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
    
    # Validate signature format
    if len(sig_hex) != 128 or not re.match(r'^[0-9a-fA-F]{128}$', sig_hex):
        raise ValueError("Invalid sig_hex: Must be 128-char hex (64 bytes)")
    
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
            contract_id=contract_id,
            user_email=user_email,
            wallet_id=wallet_id,
            access_token=access_token
        )
    except Exception as e:
        logger.error(f"Record tx error for {near_account_id}: {e}")
        raise ValueError(f"Record failed: {str(e)}")

@mcp.tool
async def composite_upload(ctx: Context, group_id: str, user_id: str, data: str, filename: str, payload_b64: str, sig_hex: str) -> dict:
    """
    Full upload: get_key → encrypt → IPFS pin → record tx.
    Uses authenticated user context to fetch signing key from Shade TEE.
    """
    # Get authenticated user from headers
    user = get_authenticated_user()
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    
    session_token = user["session_token"]
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    
    if not near_account_id:
        raise ValueError("No NEAR account; complete account setup first.")
    
    effective_user_id = user_id or near_account_id
    contract_id = CONTRACT_ID
    
    # Estimate fees
    claim_fee = await _estimate_fee("claim_token")
    record_fee = await _estimate_fee("record_transaction")
    total_fee = claim_fee + record_fee
    gas_margin = 400_000_000_000_000
    total_attach = total_fee + gas_margin  # Logged for relayer budgeting
    
    logger.info(f"Starting composite upload for {effective_user_id} (est total fee: {total_fee / 1e24:.4f} NEAR)")
    
    # Normalize data to bytes
    try:
        data_bytes = base64.b64decode(data, validate=True)
    except Exception:
        data_bytes = data.encode('utf-8')

    try:
        # Step 1: Fetch key from shade
        key = await _get_shade_key(group_id=group_id, user_id=near_account_id, payload_b64=payload_b64, sig_hex=sig_hex, user_email=user_email, wallet_id=wallet_id, access_token=access_token)
        # Step 2: Encrypt (sync, fast)
        encrypted_b64 = _encrypt_data(data, key)
        # Step 3: Async IPFS upload
        cid = await _ipfs_upload(encrypted_b64, filename)
        # Step 4: Hash original data
        file_hash = hashlib.sha256(data_bytes).hexdigest()
        # Step 5: Record tx (uses relayer)
        trans_id = await _record_near_transaction(group_id=group_id, user_id=near_account_id, file_hash=file_hash, ipfs_hash=cid, user_email=user_email, wallet_id=wallet_id, access_token=access_token)
        logger.info(f"Composite upload success: CID={cid}, Trans={trans_id}")
        return {
            "cid": cid,
            "trans_id": trans_id,
            "file_hash": file_hash,
            "fee_breakdown": {
                "claim": claim_fee / 1e24,
                "record": record_fee / 1e24,
                "total": total_fee / 1e24
            }
        }
    
    except ValueError as e:
        logger.warning(f"Composite upload auth/param error for {effective_user_id}: {e}")
        raise ValueError(f"Upload auth/param error: {str(e)}")
    except RuntimeError as e:
        logger.error(f"Composite upload runtime error for {effective_user_id}: {e}")
        raise RuntimeError(f"Upload failed (relayer/IPFS/Shade): {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected composite upload error for {effective_user_id}: {e}")
        raise RuntimeError(f"Composite upload failed: {str(e)}")
    
@mcp.tool
async def composite_retrieve(ctx: Context, group_id: str, ipfs_hash: str, payload_b64: str, sig_hex: str) -> dict:
    """Full retrieve: get_key → fetch IPFS → decrypt (uses session). Client provides signed payload_b64/sig_hex for key."""
    contract_id = CONTRACT_ID
    user = get_authenticated_user()
    user_email = user.get("email")
    wallet_id = user.get("wallet_id")
    access_token = user.get("access_token")
    near_account_id = user.get("near_account_id")
    session_token = user.get("session_token")
    
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    if not near_account_id:
        raise ValueError("No NEAR account configured; complete FastAuth signup.")
    if not ipfs_hash.startswith('Qm'):
        raise ValueError(f"Invalid CID: {ipfs_hash}")
    
    est_claim_fee = await _estimate_fee("claim_token")
    
    logger.info(f"Starting composite retrieve for {near_account_id} from group {group_id}, (est fee: {est_claim_fee / 1e24:.4f} NEAR)")
    
    try:
        # Step 1: Fetch key (uses relayer for claim; client-signed)
        key = await _get_shade_key(group_id=group_id, user_id=near_account_id, payload_b64=payload_b64, sig_hex=sig_hex, user_email=user_email, wallet_id=wallet_id, access_token=access_token)
        # Step 2: Async IPFS fetch
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash)
        # Step 3: Decrypt (sync, fast)
        decrypted_b64 = _decrypt_data(encrypted_b64, key)
        # Step 4: Hash for verification
        decrypted_data = base64.b64decode(decrypted_b64)
        file_hash = hashlib.sha256(decrypted_data).hexdigest()
        logger.info(f"Composite retrieve success for {near_account_id} from group {group_id}: {len(decrypted_data)} bytes, hash={file_hash}")
        
        return {
            "decrypted_b64": decrypted_b64,
            "file_hash": file_hash,
            "fee_breakdown": {"claim": est_claim_fee / 1e24},
            "ipfs_hash": ipfs_hash,
            "group_id": group_id
        }
    
    except ValueError as e:
        logger.warning(f"Composite retrieve auth/param error for {near_account_id}: {e}")
        raise ValueError(f"Retrieve auth/param error: {str(e)}")
    except RuntimeError as e:
        logger.error(f"Composite retrieve runtime error for {near_account_id}: {e}")
        raise RuntimeError(f"Retrieve failed (relayer/IPFS/Shade): {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected composite retrieve error for {near_account_id}: {e}")
        raise RuntimeError(f"Composite retrieve failed: {str(e)}")

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
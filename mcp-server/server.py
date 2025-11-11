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
from fastapi import Request, FastAPI, HTTPException
from fastapi.responses import RedirectResponse
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
import httpx
import uvicorn

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
            email_hash TEXT UNIQUE NOT NULL,  -- Always hashed for minimization
            email TEXT,  -- Raw only if consented (set post-consent)
            session_token TEXT NOT NULL,
            near_account_id TEXT,
            consent_given BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_session ON users(session_token)')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS consents (
            user_id INTEGER PRIMARY KEY,
            granted_at TIMESTAMP,
            revoked_at TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
    ''')
    cursor.execute('CREATE TABLE IF NOT EXISTS exports_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_session TEXT, fields_exported TEXT, exported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    cursor.execute('CREATE TABLE IF NOT EXISTS deletes_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, email_hash TEXT, reason TEXT, deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)')
    conn.commit()

def store_user_email(email: str, session_token: str, near_account_id: Optional[str] = None, consent: bool = False) -> int:
    hashed_email = hashlib.sha256(email.encode()).hexdigest()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO users (email_hash, email, session_token, near_account_id, consent_given) VALUES (?, ?, ?, ?, ?)",
            (hashed_email, email if consent else None, session_token, near_account_id, consent)
        )
        user_id = cursor.lastrowid
        if consent:
            cursor.execute("INSERT OR REPLACE INTO consents (user_id, granted_at) VALUES (?, CURRENT_TIMESTAMP)", (user_id,))
            logger.info(f"Consent granted for hashed email {hashed_email[:16]}...")
        conn.commit()
        return user_id

def get_user_session(session_token: str) -> Optional[Dict[str, Any]]:
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, email, near_account_id, consent_given FROM users WHERE session_token = ?", (session_token,))
        row = cursor.fetchone()
        if row:
            return {"id": row[0], "email": row[1], "near_account_id": row[2], "consent_given": bool(row[3])}
        return None
    
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

mcp = FastMCP(name="nova-mcp", auth=auth_provider)

# FastAPI for callback 
app = mcp.http_app()

@app.get("/auth/callback")
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
    session_token = claims.get("sub")
    near_account_id = claims.get("near_account_id")  # From FastAuth if pre-set
    if not email:
        raise HTTPException(status_code=400, detail="No email in claims")
    
    # FastAuth NEAR gen (if not pre-set)
    if not near_account_id:
        near_account_id = await create_near_account(email, id_token)
    
    store_user_email(email, session_token, near_account_id, consent=True)
    logger.info(f"New/updated user: hashed {hashlib.sha256(email.encode()).hexdigest()[:16]}... -> {near_account_id}")
    
    return RedirectResponse(
        url=f"https://nova-sdk.com?token={id_token}&near={near_account_id}",
        status_code=302
    )

async def create_near_account(email: str, id_token: str) -> str:
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
        try:
            resp = await client.post(
                f"{RELAYER_URL}/v1/account/create",  # Relayer v1 (2025)
                json={
                    "email": email,
                    "provider": "auth0",
                    "token": id_token  # Auth0 verification
                }
            )
            resp.raise_for_status()
            data = resp.json()
            account_id = data.get("account_id")
            if not account_id:
                raise ValueError("No account_id in relayer response")
            logger.info(f"Relayer created account for hashed {hashlib.sha256(email.encode()).hexdigest()[:16]}...")
            return account_id
        except httpx.HTTPStatusError as e:
            logger.error(f"Relayer HTTP error {e.response.status_code}: {e.response.text[:100]}")
            raise ValueError(f"Relayer account creation failed ({e.response.status_code}): {e.response.text[:100]}")
        except Exception as e:
            logger.error(f"Relayer general error: {e}")
            raise ValueError(f"Relayer unavailable: {str(e)}")

# Middleware: Use ctx for token/user injection
@mcp.middleware
async def auth_middleware(ctx: Context):
    token = ctx.token  # From auth_provider
    if not token:
        raise ValueError("Missing auth token")
    try:
        claims = auth_provider.token_verifier.verify(token)
        email = claims.get("email")
        session_token = claims.get("sub")
        near_account_id = claims.get("near_account_id", claims.get("near"))  # From callback
        if email:
            store_user_email(email, session_token, near_account_id)
        ctx.state.user = {"email": email, "session_token": session_token, "near_account_id": near_account_id}
        logger.info(f"Auth success for {email}")
    except Exception as e:
        logger.error(f"Auth middleware error: {e}")
        raise ValueError(f"Invalid token: {str(e)}")

# Relayer signer (no privkey; chain sigs via relayer)
async def get_user_signer(near_account_id: str, session_token: str) -> Account:
    """Production relayer signer: Submits unsigned txs via NEAR MGR v1 (chain sigs).
    
    - Validates inputs.
    - Retries on transient errors (e.g., 429/503).
    - Mimics py_near response: {'status': {'SuccessValue': str}}.
    - Views use base Account (no override needed).
    """
    if not near_account_id or not session_token:
        raise ValueError("near_account_id and session_token required")
    if len(session_token) < 10:  # Basic len check (OIDC sub ~36 chars)
        raise ValueError("Invalid session_token")

    class RelayerAccount(Account):
        def __init__(self, account_id: str, rpc_url: str):
            super().__init__(account_id, "", rpc_url)  # Dummy key; relayer signs

        async def function_call(self, contract_id: str, method_name: str, args: Dict[str, Any],
                                amount: int = 0, gas: int = 100_000_000_000_000) -> Dict[str, Any]:
            """Override: Build unsigned tx JSON, submit to relayer."""
            # Build actions (FunctionCall only for MCP tools)
            actions = [{
                "method_name": method_name,
                "args": json.dumps(args),
                "gas": gas,
                "deposit": amount
            }]
            tx_payload = {
                "signer_id": self.account_id,
                "receiver_id": contract_id,
                "actions": actions,
                "meta": {"session_token": session_token}  # Auth for relayer
            }

            relayer_url = f"{RELAYER_URL}/v1/tx/relay"  # 2025 MGR endpoint
            max_retries = 3
            for attempt in range(max_retries):
                try:
                    async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                        resp = await client.post(relayer_url, json=tx_payload)
                        resp.raise_for_status()  # 4xx/5xx → HTTPError
                        result = resp.json()
                    
                    # Validate response (mimic py_near)
                    status = result.get("status", {})
                    if "SuccessValue" not in status:
                        raise ValueError(f"Relayer failed: {result.get('error', 'Unknown')}")
                    
                    logger.info(f"Relayer tx success for {self.account_id} (attempt {attempt + 1})")
                    return {"status": status}
                    
                except httpx.HTTPStatusError as e:
                    if e.response.status_code in (429, 503) and attempt < max_retries - 1:
                        wait = (2 ** attempt) * 1000  # Exp backoff ms
                        logger.warning(f"Relayer retry {attempt + 1}/{max_retries} (status: {e.response.status_code}); wait {wait}ms")
                        await asyncio.sleep(wait / 1000)
                        continue
                    raise ValueError(f"Relayer HTTP error: {e.response.status_code} - {e.response.text[:100]}")
                except httpx.TimeoutException:
                    if attempt < max_retries - 1:
                        logger.warning(f"Relayer timeout; retry {attempt + 1}/{max_retries}")
                        await asyncio.sleep(2 ** attempt)
                        continue
                    raise ValueError("Relayer timeout after retries")
                except Exception as e:
                    raise ValueError(f"Relayer unexpected error: {str(e)}")

    # Base Account for views (unchanged)
    return RelayerAccount(near_account_id, RPC_URL)

# Wrap sync helpers (e.g., ipfs_upload)
async def _async_ipfs_upload(encrypted_b64: str, filename: str) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _ipfs_upload, encrypted_b64, filename)

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
async def _get_shade_key(group_id: str, user_id: str, contract_id: str, session_token: str, payload_b64: str, sig_hex: str) -> str:
    """Internal: Use pre-signed payload/sig → claim token → fetch key → verify checksum.
    Expects client-signed payload_b64 and sig_hex (Ed25519 on raw payload bytes).
    """
    user_session = get_user_session(session_token)
    if not user_session:
        raise ValueError("Invalid session token")
    effective_user_id = user_id or user_session["near_account_id"]
    acc = await get_user_signer(effective_user_id, session_token)  # Relayer for tx submission
    
    rpc = RPC_URL
    contract_id = contract_id or CONTRACT_ID
    try:
        # Validate provided sig (basic length/check; full verify in contract)
        if len(sig_hex) != 128 or not re.match(r'^[0-9a-fA-F]{128}$', sig_hex):  # 64 bytes hex
            raise ValueError("Invalid sig_hex: Must be 128-char hex")
        
        logger.info(f"Using pre-signed payload_b64 for {effective_user_id}: {payload_b64[:50]}...")

        # Step 1: Claim token (relayer submits tx; contract verifies sig)
        est_fee = await _estimate_fee(contract_id, "claim_token")
        gas_margin = 100_000_000_000_000
        total_attach = est_fee + gas_margin
        args_dict = {"group_id": group_id, "payload_b64": payload_b64, "signature_hex": sig_hex}
        claim_result = await acc.function_call(
            contract_id=contract_id, method_name="claim_token", args=args_dict,
            amount=total_attach, gas=100_000_000_000_000
        )
        if "SuccessValue" not in claim_result.status:
            raise Exception(f"Token claim failed (check sig/authorization): {claim_result.status}")
        token_b64 = claim_result.status['SuccessValue']
        token_bytes = base64.b64decode(token_b64)
        token = token_bytes.decode('utf-8').strip('"')

        if not token:
            raise Exception(f"No token claimed for {group_id}/{effective_user_id}")

        logger.info(f"Decoded token for {effective_user_id}: {token[:50]}...")
        logger.info(f"Claim fee: {est_fee / 1e24:.4f} NEAR")

        # Step 2: Shade fetch + checksum
        async with httpx.AsyncClient() as client:
            shade_response = await client.post(
                f"{SHADE_API_URL}/api/key-management/get_key",
                json={"group_id": group_id, "token": token},
                timeout=15
            )
            shade_response.raise_for_status()  # Raises on 4xx/5xx
            shade_data = shade_response.json()
        
        key = shade_data.get("key")
        checksum = shade_data.get("checksum")
        if not key or not checksum:
            raise Exception("Invalid Shade response")
        verified = await verify_shade_checksum_for_group(group_id, checksum, contract_id)
        if not verified:
            raise Exception(f"Shade attestation invalid for {group_id}")
        logger.info(f"Retrieved key for {group_id}/{effective_user_id} (checksum: {checksum})")
        return key
    except Exception as e:
        if "Unauthorized" in str(e) or "Invalid signature" in str(e):
            raise Exception("Unauthorized or invalid signature: Ensure client signed correctly.")
        raise Exception(f"Shade key fetch failed: {str(e)}")
    
async def _group_contains_key(group_id: str, contract_id: str) -> bool:
    """Internal: Check if group exists (view)."""
    rpc = os.environ["RPC_URL"]
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    private_key = os.environ.get("NEAR_PRIVATE_KEY", "")  # Dummy
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
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    private_key = os.environ.get("NEAR_PRIVATE_KEY", "")  # Dummy
    acc = Account(user_id, private_key, rpc)
    await acc.startup()
    result = await acc.view_function(
        contract_id=contract_id,
        method_name="is_authorized",
        args={"group_id": group_id, "user_id": user_id}
    )
    return result.result

def _encrypt_data(data: str, key: str) -> str:
    """Internal: Encrypts (same as tool)."""
    data_bytes = base64.b64decode(data)
    key_bytes = base64.b64decode(key)[:32]
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(key_bytes), modes.CBC(iv), backend=default_backend())
    encryptor = cipher.encryptor()
    pad_len = 16 - (len(data_bytes) % 16)
    padded = data_bytes + bytes([pad_len] * pad_len)
    encrypted = encryptor.update(padded) + encryptor.finalize()
    return base64.b64encode(iv + encrypted).decode('utf-8')

def _decrypt_data(encrypted: str, key: str) -> str:
    """Internal: Decrypts (same as tool)."""
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

async def _record_near_transaction(group_id: str, user_id: str, file_hash: str, ipfs_hash: str, contract_id: str, session_token: str) -> str:
    """Internal: Records tx using session signer (relayer)."""
    user_session = get_user_session(session_token)
    if not user_session:
        raise ValueError("Invalid session token")
    effective_account_id = user_session["near_account_id"]
    if not effective_account_id:
        raise ValueError("No NEAR account in session")
    acc = await get_user_signer(effective_account_id, session_token)
    
    contract_id = contract_id or CONTRACT_ID
    est_fee = await _estimate_fee(contract_id, "record_transaction")
    gas_margin = 100_000_000_000_000
    total_attach = est_fee + gas_margin  # Relayer budgets; log only
    logger.info(f"Submitting record tx for {effective_account_id} (est fee: {est_fee / 1e24:.4f} NEAR)")
    
    try:
        result = await acc.function_call(
            contract_id=contract_id, method_name="record_transaction",
            args={"group_id": group_id, "user_id": user_id, "file_hash": file_hash, "ipfs_hash": ipfs_hash},
            amount=total_attach, gas=100_000_000_000_000
        )
        # Relayer may return dict; normalize
        status = result.get("status", result.status if hasattr(result, "status") else str(result))
        if "SuccessValue" in status:
            trans_id = result.get("SuccessValue", status["SuccessValue"])
            logger.info(f"Recorded tx: {trans_id} (fee: {est_fee / 1e24:.4f} NEAR)")
            # Log breakdown (unchanged)
            ipfs_est = 0.005; phala_est = 0.003; nova_fee = est_fee / 1e24
            logger.info(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
            return trans_id
        else:
            raise ValueError(f"Record failed (relayer error): {status}")
    except httpx.TimeoutException:
        raise ValueError("Relayer timeout: Try again later")
    except Exception as e:
        logger.error(f"Relayer submission error: {e}")
        raise ValueError(f"Record failed (relayer submission): {str(e)}")

async def _estimate_fee(contract_id: str, action: str) -> int:
    """Queries contract for fee yoctoNEAR."""
    rpc = os.environ["RPC_URL"]
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    private_key = os.environ.get("NEAR_PRIVATE_KEY", "")  # Dummy for view
    acc = Account("dummy", private_key, rpc)
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
@mcp.requires_auth
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
@mcp.requires_auth
async def ipfs_retrieve(cid: str) -> str:  # Returns base64 bytes (now async)
    """Retrieves data from IPFS via Pinata gateway."""
    return await _ipfs_retrieve(cid)

@mcp.tool
@mcp.requires_auth
def encrypt_data(data: str, key: str) -> str:  # Input b64 data/key; return b64 encrypted
    """Encrypts base64 data with AES-CBC key (32 bytes padded)."""
    return _encrypt_data(data, key)

@mcp.tool
@mcp.requires_auth
def decrypt_data(encrypted: str, key: str) -> str:  # b64 in/out
    """Decrypts base64 encrypted data with AES-CBC key."""
    return _decrypt_data(encrypted, key)

# Consent Tool (GDPR)
@mcp.tool
async def set_consent(ctx: Context, granted: bool = True) -> str:
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required.")
    session_token = user["session_token"]

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE session_token = ?", (session_token,))
        row = cursor.fetchone()
        if not row:
            raise ValueError("User session not found.")
        user_id = row[0]
        
        cursor.execute("UPDATE users SET consent_given = ? WHERE session_token = ?", (granted, session_token))
        updated = cursor.rowcount > 0
        
        if granted and updated:
            cursor.execute("INSERT OR REPLACE INTO consents (user_id, granted_at) VALUES (?, CURRENT_TIMESTAMP)", (user_id,))
            logger.info(f"Consent granted for user {user_id}")
        elif not granted and updated:
            cursor.execute("UPDATE consents SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL", (user_id,))
            logger.info(f"Consent revoked for user {user_id}")
        
        conn.commit()
    
    return f"Consent {'granted' if granted else 'revoked'} successfully." if updated else "No changes (already set)."

# Export/Delete from DB Tools
@mcp.tool
async def export_data(ctx: Context) -> dict:
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required.")

    session_token = user["session_token"]
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT u.email, u.email_hash, u.near_account_id, u.created_at, u.consent_given,
                   c.granted_at, c.revoked_at 
            FROM users u LEFT JOIN consents c ON u.id = c.user_id 
            WHERE u.session_token = ?
        """, (session_token,))
        row = cursor.fetchone()
        if not row:
            raise ValueError("No data found.")
        
        consent_given = bool(row[4])
        export_data = {
            "near_account_id": row[2] or None,
            "created_at": row[3],
            "consent_history": {"granted_at": row[5], "revoked_at": row[6]}
        }
        
        # GDPR: Raw email only if consented
        if consent_given:
            export_data["email"] = row[0]  # Raw
            logger.info(f"Full export for user {user['id'] if 'id' in user else 'unknown'} (consent: True)")
        else:
            export_data["email_hash"] = row[1]  # Hashed
            logger.warning(f"Limited export for session {session_token[:16]}... (consent: False)")
        
        # Audit log (only if consented)
        if consent_given:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS exports_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_session TEXT,
                    fields_exported TEXT,
                    exported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            fields_exported = json.dumps(list(export_data.keys()))
            cursor.execute("INSERT INTO exports_log (user_session, fields_exported) VALUES (?, ?)", (session_token, fields_exported))
            conn.commit()
    
    return {"data": export_data}

@mcp.tool
async def delete_data(ctx: Context, reason: str = "user_request") -> str:
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required.")

    session_token = user["session_token"]
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, email_hash FROM users WHERE session_token = ?", (session_token,))
        row = cursor.fetchone()
        if not row:
            raise ValueError("No data found to delete.")
        user_id, email_hash = row
        
        # Cascade delete
        cursor.execute("DELETE FROM consents WHERE user_id = ?", (user_id,))
        cursor.execute("DELETE FROM exports_log WHERE user_session = ?", (session_token,))
        cursor.execute("DELETE FROM deletes_log WHERE user_session = ?", (session_token,))  # Clean prior deletes
        cursor.execute("DELETE FROM users WHERE session_token = ?", (session_token,))
        deleted_rows = cursor.rowcount
        
        conn.commit()
        
        if deleted_rows > 0:
            # Audit log
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS deletes_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    email_hash TEXT,
                    reason TEXT,
                    deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            cursor.execute("INSERT INTO deletes_log (user_id, email_hash, reason) VALUES (?, ?, ?)", (user_id, email_hash, reason))
            conn.commit()
            
            logger.warning(f"Data deleted for user {user_id} (hash: {email_hash[:16]}..., reason: {reason}) - GDPR erasure")
            
            return f"Data deleted successfully (GDPR compliance). Reason logged: {reason}. {deleted_rows} records removed."
        raise ValueError("No data found to delete.")

# Tools for NOVA contract interaction (requires valid auth)
@mcp.tool
@mcp.requires_auth
async def register_group(ctx: Context, group_id: str) -> str:
    """Registers new group on NOVA contract as the authenticated user (owner)."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Relayer signer (unsigned tx submission)
    acc = await get_user_signer(near_account_id, session_token)
    
    contract_id = os.environ.get("CONTRACT_ID", "nova-sdk-5.testnet")
    if await _group_contains_key(group_id, contract_id):
        raise ValueError(f"Group {group_id} exists")
    
    # Estimate fee + gas margin (relayer budgets; log only)
    est_fee = await _estimate_fee(contract_id, "register_group")
    gas_margin = 300_000_000_000_000  # 300 TGas equiv
    total_attach = est_fee + gas_margin
    logger.info(f"Submitting register for {near_account_id} (est fee: {est_fee / 1e24:.4f} NEAR)")

    try:
        result = await acc.function_call(
            contract_id=contract_id,
            method_name="register_group",
            args={"group_id": group_id},
            amount=total_attach,
            gas=int("300000000000000")  # Relayer handles
        )
        # Normalize result (dict from relayer or py_near obj)
        status = result.get("status") if isinstance(result, dict) else (result.status if hasattr(result, "status") else str(result))
        if "SuccessValue" in status:
            logger.info(f"Registered group: {group_id} by {near_account_id}")

            # Off-chain: Trigger Shade key gen (unchanged, async)
            async with httpx.AsyncClient() as client:
                shade_response = await client.post(
                    f"{SHADE_API_URL}/api/key-management/generate_key",
                    json={"group_id": group_id, "owner": near_account_id},
                    timeout=15
                )
                shade_response.raise_for_status()
                shade_data = shade_response.json()
            
            checksum = shade_data.get("checksum")
            if checksum:
                # Update checksum (relayer tx)
                checksum_est = await _estimate_fee(contract_id, "update_checksum")
                checksum_total = checksum_est + 50_000_000_000_000
                update_result = await acc.function_call(
                    contract_id=contract_id,
                    method_name="update_checksum",
                    args={"group_id": group_id, "checksum": checksum},
                    amount=checksum_total,
                    gas=int("50000000000000")
                )
                update_status = update_result.get("status") if isinstance(update_result, dict) else (update_result.status if hasattr(update_result, "status") else str(update_result))
                if "SuccessValue" not in update_status:
                    raise ValueError(f"Checksum update failed: {update_status}")
                logger.info(f"Checksum auto-updated for {group_id}: {checksum}")
            else:
                raise ValueError("Shade gen returned no checksum")
            
            # Log breakdown
            ipfs_est = 0.005; phala_est = 0.003; nova_fee = est_fee / 1e24
            logger.info(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
            
            return f"Registered (with Shade key gen for {group_id})"
        else:
            raise ValueError(f"Register failed (relayer error): {status}. Ensure unique group_id and session validity.")
    except httpx.TimeoutException:
        raise ValueError("Relayer timeout: Try again later")
    except Exception as e:
        logger.error(f"Relayer submission error for register: {e}")
        raise ValueError(f"Register failed (relayer submission): {str(e)}")

@mcp.tool
@mcp.requires_auth
async def add_group_member(ctx: Context, group_id: str, member_id: str) -> str:
    """Adds member to group (owner only, uses authenticated session)."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Relayer signer
    acc = await get_user_signer(near_account_id, session_token)
    
    contract_id = os.environ.get("CONTRACT_ID", "nova-sdk-5.testnet")
    if not await _group_contains_key(group_id, contract_id):
        raise ValueError(f"Group {group_id} not found")
    if await _is_authorized(group_id, member_id, contract_id):
        raise ValueError(f"User {member_id} already a member")
    
    # Estimate (relayer budgets)
    est_fee = await _estimate_fee(contract_id, "add_group_member")
    gas_margin = 300_000_000_000_000
    total_attach = est_fee + gas_margin
    logger.info(f"Submitting add member {member_id} to {group_id} by {near_account_id} (est fee: {est_fee / 1e24:.4f} NEAR)")

    try:
        result = await acc.function_call(
            contract_id=contract_id,
            method_name="add_group_member",
            args={"group_id": group_id, "user_id": member_id},
            amount=total_attach,
            gas=int("300000000000000")
        )
        status = result.get("status") if isinstance(result, dict) else (result.status if hasattr(result, "status") else str(result))
        if "SuccessValue" in status:
            logger.info(f"Added {member_id} to {group_id} by {near_account_id}")
            
            # Log breakdown
            ipfs_est = 0.005; phala_est = 0.003; nova_fee = est_fee / 1e24
            logger.info(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
            
            return "Added"
        else:
            raise ValueError(f"Add failed (relayer error): {status}. Ensure owner auth and session validity.")
    except httpx.TimeoutException:
        raise ValueError("Relayer timeout: Try again later")
    except Exception as e:
        logger.error(f"Relayer submission error for add member: {e}")
        raise ValueError(f"Add failed (relayer submission): {str(e)}")

@mcp.tool
@mcp.requires_auth
async def revoke_group_member(ctx: Context, group_id: str, member_id: str) -> str:
    """Revokes member from group (owner only, rotates key, uses authenticated session)."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    # Relayer signer
    acc = await get_user_signer(near_account_id, session_token)
    
    contract_id = os.environ.get("CONTRACT_ID", "nova-sdk-5.testnet")
    if not await _group_contains_key(group_id, contract_id):
        raise ValueError(f"Group {group_id} not found")
    if not await _is_authorized(group_id, member_id, contract_id):
        raise ValueError(f"User {member_id} not a member")
    
    # Estimate (relayer budgets)
    est_fee = await _estimate_fee(contract_id, "revoke_group_member")
    gas_margin = 300_000_000_000_000
    total_attach = est_fee + gas_margin
    logger.info(f"Submitting revoke {member_id} from {group_id} by {near_account_id} (est fee: {est_fee / 1e24:.4f} NEAR)")

    try:
        result = await acc.function_call(
            contract_id=contract_id,
            method_name="revoke_group_member",
            args={"group_id": group_id, "user_id": member_id},
            amount=total_attach,
            gas=int("300000000000000")
        )
        status = result.get("status") if isinstance(result, dict) else (result.status if hasattr(result, "status") else str(result))
        if "SuccessValue" in status:
            logger.info(f"Revoked {member_id} from {group_id} by {near_account_id}, key rotated")
            
            # Off-chain: Trigger Shade key rotation (async)
            async with httpx.AsyncClient() as client:
                shade_response = await client.post(
                    f"{SHADE_API_URL}/api/key-management/rotate_key",
                    json={"group_id": group_id},
                    timeout=15
                )
                shade_response.raise_for_status()
                shade_data = shade_response.json()
                if not shade_data.get("success"):
                    raise ValueError("Shade rotate succeeded but no success flag")
                logger.info(f"Key rotated in Shade for {group_id}")
            
            # Log breakdown
            ipfs_est = 0.005; phala_est = 0.003; nova_fee = est_fee / 1e24
            logger.info(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
            
            return "Revoked (with Shade key rotate)"
        else:
            raise ValueError(f"Revoke failed (relayer error): {status}. Ensure owner auth and session validity.")
    except httpx.TimeoutException:
        raise ValueError("Relayer timeout: Try again later")
    except Exception as e:
        logger.error(f"Relayer submission error for revoke: {e}")
        raise ValueError(f"Revoke failed (relayer submission): {str(e)}")

@mcp.tool
@mcp.requires_auth
async def get_shade_key(ctx: Context, group_id: str, payload_b64: str, sig_hex: str, user_id: Optional[str] = None, contract_id: str = None) -> str:
    """Retrieves key: Pass pre-signed payload_b64 (JSON base64) and sig_hex (Ed25519 on raw payload).
    Sign client-side with user's key before calling. user_id optional: defaults to session user.
    """
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    session_token = user["session_token"]
    session_user_id = user.get("near_account_id")
    if not session_user_id:
        raise ValueError("No NEAR account in session; complete FastAuth signup.")
    
    # Derive effective user_id (override only if matches session for security)
    effective_user_id = user_id or session_user_id
    if user_id and user_id != session_user_id:
        raise ValueError("user_id must match session account (no delegation)")
    
    # Basic sig validation (length/hex; contract verifies full)
    if len(sig_hex) != 128 or not re.match(r'^[0-9a-fA-F]{128}$', sig_hex):
        raise ValueError("Invalid sig_hex: Must be 128-char hex (64 bytes)")
    
    contract_id = contract_id or CONTRACT_ID
    return await _get_shade_key(group_id, effective_user_id, contract_id, session_token, payload_b64, sig_hex)


@mcp.tool
@mcp.requires_auth
async def record_near_transaction(ctx: Context, group_id: str, user_id: str, file_hash: str, ipfs_hash: str, contract_id: str = None) -> str:
    """Records file tx on NOVA contract (uses session signer)."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    contract_id = contract_id or CONTRACT_ID
    # Delegate to helper (now relayer-aware)
    try:
        return await _record_near_transaction(group_id, user_id, file_hash, ipfs_hash, contract_id, session_token)
    except Exception as e:
        logger.error(f"Record tx error for {near_account_id}: {e}")
        raise ValueError(f"Record failed: {str(e)}")

@mcp.tool
@mcp.requires_auth
async def composite_upload(ctx: Context, group_id: str, user_id: str, data: str, filename: str, payload_b64: str, sig_hex: str, contract_id: str = None) -> dict:
    """Full upload: get_key → encrypt → IPFS pin → record tx (uses session). Client provides signed payload_b64/sig_hex."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    effective_user_id = user_id or near_account_id
    contract_id = contract_id or CONTRACT_ID
    
    claim_fee = await _estimate_fee(contract_id, "claim_token")
    record_fee = await _estimate_fee(contract_id, "record_transaction")
    total_fee = claim_fee + record_fee
    gas_margin = 400_000_000_000_000
    total_attach = total_fee + gas_margin  # Logged for relayer budgeting
    
    logger.info(f"Starting composite upload for {effective_user_id} (est total fee: {total_fee / 1e24:.4f} NEAR)")
    
    try:
        # Step 1: Fetch key (uses relayer for claim)
        key = await _get_shade_key(group_id, effective_user_id, contract_id, session_token, payload_b64, sig_hex)
        # Step 2: Encrypt (sync, fast)
        encrypted_b64 = _encrypt_data(data, key)
        # Step 3: Async IPFS upload
        cid = await _ipfs_upload(encrypted_b64, filename)  # Direct async call
        # Step 4: Hash original data
        file_hash = hashlib.sha256(base64.b64decode(data)).hexdigest()
        # Step 5: Record tx (uses relayer)
        trans_id = await _record_near_transaction(group_id, effective_user_id, file_hash, cid, contract_id, session_token)
        logger.info(f"Composite upload success: CID={cid}, Trans={trans_id}")
        return {
            "cid": cid, "trans_id": trans_id, "file_hash": file_hash,
            "fee_breakdown": {"claim": claim_fee / 1e24, "record": record_fee / 1e24, "total": total_fee / 1e24}
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
@mcp.requires_auth
async def composite_retrieve(ctx: Context, group_id: str, ipfs_hash: str, payload_b64: str, sig_hex: str, contract_id: str = None) -> dict:
    """Full retrieve: get_key → fetch IPFS → decrypt (uses session). Client provides signed payload_b64/sig_hex for key."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required: Connect wallet first.")
    session_token = user["session_token"]
    near_account_id = user.get("near_account_id")
    if not near_account_id:
        raise ValueError("No NEAR account; complete FastAuth signup.")
    
    effective_user_id = near_account_id
    contract_id = contract_id or CONTRACT_ID
    if not ipfs_hash.startswith('Qm'):
        raise ValueError(f"Invalid CID: {ipfs_hash}")
    
    est_claim_fee = await _estimate_fee(contract_id, "claim_token")
    logger.info(f"Starting composite retrieve for {effective_user_id} (est fee: {est_claim_fee / 1e24:.4f} NEAR)")
    
    try:
        # Step 1: Fetch key (uses relayer for claim; client-signed)
        key = await _get_shade_key(group_id, effective_user_id, contract_id, session_token, payload_b64, sig_hex)
        # Step 2: Async IPFS fetch
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash)
        # Step 3: Decrypt (sync, fast)
        decrypted_b64 = _decrypt_data(encrypted_b64, key)
        # Step 4: Hash for verification
        decrypted_data = base64.b64decode(decrypted_b64)
        file_hash = hashlib.sha256(decrypted_data).hexdigest()
        logger.info(f"Composite retrieve success: {len(decrypted_data)} bytes, hash={file_hash}")
        return {
            "decrypted_b64": decrypted_b64,
            "file_hash": file_hash,
            "fee_breakdown": {"claim": est_claim_fee / 1e24}
        }
    except ValueError as e:
        logger.warning(f"Composite retrieve auth/param error for {effective_user_id}: {e}")
        raise ValueError(f"Retrieve auth/param error: {str(e)}")
    except RuntimeError as e:
        logger.error(f"Composite retrieve runtime error for {effective_user_id}: {e}")
        raise RuntimeError(f"Retrieve failed (relayer/IPFS/Shade): {str(e)}")
    except Exception as e:
        logger.error(f"Unexpected composite retrieve error for {effective_user_id}: {e}")
        raise RuntimeError(f"Composite retrieve failed: {str(e)}")

@mcp.tool
async def auth_status(ctx: Context, user_id: str = None, group_id: str = "test_group") -> dict:
    """Tool: Check user auth/groups on NOVA contract. Returns {'authorized': bool, 'groups': list[str], 'member_count': int}."""
    user = ctx.state.get('user')
    if not user:
        raise ValueError("Auth required.")
    
    effective_user_id = user_id or user["near_account_id"]
    if not effective_user_id:
        raise ValueError("No user_id provided or in session.")
    
    contract_id = os.environ["CONTRACT_ID"]
    rpc = os.environ["RPC_URL"]
    private_key = ""  # Dummy for views only
    try:
        acc = Account(effective_user_id, private_key, rpc)
        await acc.startup()
        # Check authorized
        auth_result = await acc.view_function(
            contract_id=contract_id,
            method_name="is_authorized",
            args={"group_id": group_id, "user_id": effective_user_id}
        )
        authorized = bool(auth_result.result)
        
        # List groups via txs (safe list comp)
        txs_result = await acc.view_function(
            contract_id=contract_id,
            method_name="get_transactions_for_group",
            args={"group_id": group_id, "user_id": effective_user_id}
        )
        tx_list = txs_result.result or []  # Handle None/empty
        groups = list(set(tx["group_id"] for tx in tx_list if "group_id" in tx))
        member_count = len(groups)
        
        logger.info(f"Auth check for {effective_user_id[:16]}... in {group_id}: authorized={authorized}, {member_count} groups")
        return {"authorized": authorized, "groups": groups, "member_count": member_count}
    except Exception as e:
        logger.error(f"Auth status error for {effective_user_id[:16]}...: {e}")
        if "Unauthorized" in str(e):
            return {"authorized": False, "groups": [], "member_count": 0}
        raise ValueError(f"Auth query failed: {str(e)}")
    

async def verify_shade_checksum_for_group(group_id: str, checksum: str, contract_id: str = None) -> bool:
    """Verifies Shade attestation checksum against on-chain expected for the group."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    rpc = os.environ["RPC_URL"]
    private_key = os.environ.get("NEAR_PRIVATE_KEY", "")  # Dummy for views
    try:
        acc = Account("dummy", private_key, rpc)  # Dummy account for view
        await acc.startup()
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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
import os
from dotenv import load_dotenv
from fastmcp import FastMCP
import base64
import requests
import time
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives import serialization
import base58
import py_near
from py_near.account import Account
import asyncio
import json
import hashlib
import re

# Load .env variables
load_dotenv()

SHADE_API_URL = os.environ.get("SHADE_API_URL", "")

mcp = FastMCP(name="nova-mcp")

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
async def _get_shade_key(group_id: str, user_id: str, contract_id: str, private_key: str = None) -> str:
    """Internal: Gen payload → sign with user priv → claim token on-chain → fetch key from Shade → verify checksum."""
    rpc = os.environ["RPC_URL"]
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    try:
        acc = Account(user_id, private_key, rpc)
        await acc.startup()
        
        # Step 0: Gen payload (derive PK early)
        timestamp = int(time.time() * 1_000_000_000)  # ns approx
        nonce_input = f"{group_id}{user_id}{timestamp}"
        nonce = hashlib.sha256(nonce_input.encode()).hexdigest()
        payload_dict = {
            "group_id": group_id,
            "user_id": user_id,
            "nonce": nonce,
            "timestamp": timestamp  # as int
        }
        
        # Step 1: Derive PK and add to dict (before signing)
        if private_key.startswith('ed25519:'):
            seed_b58 = private_key[8:]
            seed_bytes_full = base58.b58decode(seed_b58)
            if len(seed_bytes_full) != 64:
                raise Exception("Invalid full private key length")
            seed_bytes = seed_bytes_full[:32]  # Extract 32-byte seed
            private_key_obj = ed25519.Ed25519PrivateKey.from_private_bytes(seed_bytes)
        else:
            raise Exception("Invalid privkey format")
        
        # Derive public key
        public_key_obj = private_key_obj.public_key()
        public_bytes = public_key_obj.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw
        )
        # Base58 encode public
        def base58_encode(b: bytes) -> str:
            alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
            n = int.from_bytes(b, 'big')
            res = []
            while n > 0:
                n, r = divmod(n, 58)
                res.append(alphabet[r])
            res.reverse()
            # Leading zeros
            for byte in b:
                if byte == 0:
                    res.insert(0, alphabet[0])
                else:
                    break
            return ''.join(res)

        signing_pk_b58 = base58_encode(public_bytes)  # Without prefix
        payload_dict["signing_pk_b58"] = signing_pk_b58  # Add here
        
        # Now gen full payload str/bytes/b64
        payload_str = json.dumps(payload_dict)
        payload_bytes = payload_str.encode('utf-8')
        payload_b64 = base64.b64encode(payload_bytes).decode('utf-8')
        
        # Sign the FULL payload (with PK)
        sig_bytes = private_key_obj.sign(payload_bytes)  # Raw bytes
        sig_hex = sig_bytes.hex()

        print(f"Generated payload_b64: {payload_b64[:50]}...")  # Debug
        
        # Step 2: Claim token on-chain (payable call as user_id)
        # Estimate fee + gas margin
        est_fee = await _estimate_fee(contract_id, "claim_token")
        gas_margin = 100_000_000_000_000  # 100 TGas equiv
        total_attach = est_fee + gas_margin
        
        args_dict = {
            "group_id": group_id,
            "payload_b64": payload_b64,
            "signature_hex": sig_hex
        }
        claim_result = await acc.function_call(
            contract_id=contract_id,
            method_name="claim_token",
            args=args_dict,  # Dict passes as JSON
            amount=total_attach,  # 0.001 NEAR
            gas=int("100000000000000")  # 100 TGas
        )
        print("Claim status:", claim_result.status)
        if "SuccessValue" in claim_result.status:
            token_b64 = claim_result.status['SuccessValue']
            # Decode base64-wrapped str to raw token (payload_b64.sig_hex)
            token_bytes = base64.b64decode(token_b64)
            token = token_bytes.decode('utf-8').strip('"')
        else:
            raise Exception(f"Token claim failed: {claim_result.status}")
        
        if not token:
            raise Exception(f"No token claimed for {group_id}/{user_id}")
        
        print(f"Decoded token: {token[:50]}...")  # Debug
        print(f"Claim fee: {est_fee / 1e24:.4f} NEAR (auth overhead)")

        # Step 3: Call Shade API with token
        if not SHADE_API_URL:
            raise Exception("SHADE_API_URL not set")
        shade_response = requests.post(
            f"{SHADE_API_URL}/api/key-management/get_key",
            json={"group_id": group_id, "token": token},
            timeout=15
        )
        if shade_response.status_code == 200:
            shade_data = shade_response.json()
            key = shade_data.get("key")
            checksum = shade_data.get("checksum")
            if not key or not checksum:
                raise Exception("Invalid Shade response")
            # Step 4: Verify checksum
            verified = await verify_shade_checksum_for_group(group_id, checksum, contract_id)
            if not verified:
                raise Exception(f"Shade attestation invalid: checksum mismatch for {group_id}")
            print(f"Retrieved key for {group_id}/{user_id} from Shade (verified checksum: {checksum})")
            return key
        else:
            raise Exception(f"Shade fetch failed: {shade_response.text}")
    except Exception as e:
        if "Unauthorized" in str(e):
            raise Exception("Unauthorized: Provide group member creds or request access.")
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

def _ipfs_upload(encrypted_b64: str, filename: str) -> str:
    """Internal: Uploads (same as tool)."""
    encrypted_data = base64.b64decode(encrypted_b64)
    url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
    headers = {
        "pinata_api_key": os.environ["IPFS_API_KEY"],
        "pinata_secret_api_key": os.environ["IPFS_API_SECRET"]
    }
    files = {"file": (filename, encrypted_data)}
    response = requests.post(url, headers=headers, files=files)
    if response.status_code == 200:
        return response.json()["IpfsHash"]
    raise Exception(f"Upload failed: {response.text}")

async def _ipfs_retrieve(cid: str) -> str:
    """Internal: Retrieves data from IPFS via gateway (fallback to public)."""
    # Try custom gateway first
    gateway = os.environ.get("PINATA_GATEWAY", "").rstrip('/')
    if not gateway:
        gateway = "https://gateway.pinata.cloud/ipfs"
    url = f"{gateway}/{cid.lstrip('/').strip()}"
    if not cid.startswith('Qm'):
        raise Exception(f"Invalid CID: {cid}")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
    max_retries = 5
    for attempt in range(max_retries):
        try:
            response = requests.get(url, headers=headers, timeout=15)
            if response.status_code == 200 and response.content:
                return base64.b64encode(response.content).decode('utf-8')
            elif response.status_code == 400:
                raise Exception(f"Invalid path/CID: {response.text[:100]}")
            elif response.status_code == 429:
                wait = 10 * (2 ** attempt)
                time.sleep(wait)
                continue
            else:
                raise Exception(f"Failed {response.status_code}: {response.text[:100]}")
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            # Fallback to public gateway on final fail
            if gateway != "https://gateway.pinata.cloud/ipfs":
                print(f"Custom gateway failed, falling back to public: {e}")
                gateway = "https://gateway.pinata.cloud/ipfs"
                url = f"{gateway}/{cid.lstrip('/').strip()}"
                response = requests.get(url, headers=headers, timeout=15)
                if response.status_code == 200 and response.content:
                    return base64.b64encode(response.content).decode('utf-8')
            raise e
    raise Exception(f"Failed after {max_retries} retries")

async def _record_near_transaction(group_id: str, user_id: str, file_hash: str, ipfs_hash: str, contract_id: str, account_id: str, private_key: str) -> str:
    """Internal: Records (async)."""
    rpc = os.environ["RPC_URL"]
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    private_key = _validate_near_key(private_key)

    # Estimate fee + gas margin
    est_fee = await _estimate_fee(contract_id, "record_transaction")
    gas_margin = 100_000_000_000_000  # 100 TGas equiv
    total_attach = est_fee + gas_margin

    near = Account(account_id, private_key, rpc)
    await near.startup()  # Initialize account for async calls (added)
    result = await near.function_call(
        contract_id=contract_id,
        method_name="record_transaction",
        args={"group_id": group_id, "user_id": user_id, "file_hash": file_hash, "ipfs_hash": ipfs_hash},
        amount=total_attach,
        gas=int("100000000000000")  # 100 TGas
    )
    if "SuccessValue" in result.status:
        trans_id = result.status['SuccessValue']  # Direct str/hex
        print(f"Recorded tx: {trans_id} (fee: {est_fee / 1e24:.4f} NEAR)")  # Log for debug (kept from failing)
        
        # Log breakdown (static for now; dynamic via oracle later)
        ipfs_est = 0.005  # Placeholder USD equiv
        phala_est = 0.003
        nova_fee = est_fee / 1e24
        print(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
        
        return trans_id
    raise Exception(f"Record failed (check owner auth): {result.status}. Authentication required: Provide your account_id and private_key as the smart contract owner. Or deploy your own contract via `near deploy` and pass `contract_id`.")

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

# Tools for direct external use (non-restricted)
@mcp.tool
def ipfs_upload(data: str, filename: str) -> str:
    """Uploads encrypted data to IPFS via Pinata and returns CID."""
    data_bytes = base64.b64decode(data)
    url = "https://api.pinata.cloud/pinning/pinFileToIPFS"
    headers = {
        "pinata_api_key": os.environ["IPFS_API_KEY"],
        "pinata_secret_api_key": os.environ["IPFS_API_SECRET"]
    }
    files = {"file": (filename, data_bytes)}
    response = requests.post(url, headers=headers, files=files)
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
async def register_group(group_id: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> str:
    """Registers new group on NOVA contract. Provide account_id/private_key as owner if not using default."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    rpc = os.environ["RPC_URL"]
    if await _group_contains_key(group_id, contract_id):
        raise Exception(f"Group {group_id} exists")
    
    # Estimate fee + gas margin
    est_fee = await _estimate_fee(contract_id, "register_group")
    # est_dynamic = await _get_dynamic_fee(contract_id, "register_group")
    gas_margin = 300_000_000_000_000  # 300 TGas equiv
    total_attach = est_fee + gas_margin

    near = Account(account_id, private_key, rpc)
    await near.startup()
    result = await near.function_call(
        contract_id=contract_id,
        method_name="register_group",
        args={"group_id": group_id},
        amount=total_attach,
        gas=int("300000000000000")  # 300 TGas
    )
    if "SuccessValue" in result.status:
        print(f"Registered group: {group_id}")

        # Off-chain: Trigger Shade key gen
        shade_response = requests.post(
            f"{SHADE_API_URL}/api/key-management/generate_key",
            json={"group_id": group_id, "owner": account_id},
            timeout=15
        )
        if shade_response.status_code == 200:
            shade_data = shade_response.json()
            key = shade_data.get("key")
            checksum = shade_data.get("checksum")
            if checksum:
                # Update on-chain checksum
                checksum_est = await _estimate_fee(contract_id, "update_checksum")
                checksum_total = checksum_est + 50_000_000_000_000  # Gas margin
                update_result = await near.function_call(
                    contract_id=contract_id,
                    method_name="update_checksum",
                    args={"group_id": group_id, "checksum": checksum},
                    amount=checksum_total,
                    gas=int("50000000000000")  # 50 TGas
                )
                if "SuccessValue" in update_result.status:
                    print(f"Checksum auto-updated for {group_id}: {checksum}")
                else:
                    raise Exception(f"Checksum update failed: {update_result.status}")
            else:
                raise Exception("Shade gen no checksum")
        
        # Log breakdown (static for now; dynamic via oracle later)
        ipfs_est = 0.005  # Placeholder USD equiv
        phala_est = 0.003
        nova_fee = est_fee / 1e24
        print(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
        
        return f"Registered (with Shade key gen for {group_id})"
    raise Exception(f"Register failed: {result.status}. Ensure sufficient gas/deposit and unique group_id.")

@mcp.tool
async def add_group_member(group_id: str, member_id: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> str:
    """Adds member to group (owner only). Provide account_id/private_key as owner if not using default."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    rpc = os.environ["RPC_URL"]
    if not await _group_contains_key(group_id, contract_id):
        raise Exception(f"Group {group_id} not found")
    if await _is_authorized(group_id, member_id, contract_id):
        raise Exception(f"User {member_id} already a member")
    
    # Estimate fee + gas margin
    est_fee = await _estimate_fee(contract_id, "add_group_member")
    gas_margin = 300_000_000_000_000  # 300 TGas equiv
    total_attach = est_fee + gas_margin

    near = Account(account_id, private_key, rpc)
    await near.startup()  # ADD THIS
    result = await near.function_call(
        contract_id=contract_id,
        method_name="add_group_member",
        args={"group_id": group_id, "user_id": member_id},
        amount=total_attach,
        gas=int("300000000000000")
    )
    if "SuccessValue" in result.status:
        print(f"Added {member_id} to {group_id}")
        return "Added"
    raise Exception(f"Add failed (check owner auth): {result.status}. Authentication required: Provide your account_id and private_key as the smart contract owner. Or deploy your own contract via `near deploy` and pass `contract_id`.")

@mcp.tool
async def revoke_group_member(group_id: str, member_id: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> str:
    """Revokes member from group (owner only, rotates key). Provide account_id/private_key as owner if not using default."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    rpc = os.environ["RPC_URL"]
    if not await _group_contains_key(group_id, contract_id):
        raise Exception(f"Group {group_id} not found")
    if not await _is_authorized(group_id, member_id, contract_id):
        raise Exception(f"User {member_id} not a member")
    
    # Estimate fee + gas margin
    est_fee = await _estimate_fee(contract_id, "revoke_group_member")
    gas_margin = 300_000_000_000_000  # 300 TGas equiv
    total_attach = est_fee + gas_margin

    near = Account(account_id, private_key, rpc)
    await near.startup()  # Initialize account for async calls
    result = await near.function_call(
        contract_id=contract_id,
        method_name="revoke_group_member",
        args={"group_id": group_id, "user_id": member_id},
        amount=total_attach,
        gas=int("300000000000000")
    )
    if "SuccessValue" in result.status:
        print(f"Revoked {member_id} from {group_id}, key rotated")
        
        # Off-chain: Trigger Shade key rotation
        shade_response = requests.post(
            f"{SHADE_API_URL}/api/key-management/rotate_key",
            json={"group_id": group_id},
            timeout=15
        )
        if shade_response.status_code == 200:
            shade_data = shade_response.json()
            if shade_data.get("success"):
                print(f"Key rotated in Shade for {group_id}")
            else:
                raise Exception("Shade rotate succeeded but no success flag")
        else:
            raise Exception(f"Shade rotate failed: {shade_response.text}")
        
        # Log breakdown (static for now; dynamic via oracle later)
        ipfs_est = 0.005  # Placeholder USD equiv
        phala_est = 0.003
        nova_fee = est_fee / 1e24
        print(f"Cost breakdown: {nova_fee} NEAR total (est {ipfs_est} IPFS + {phala_est} Phala + {nova_fee - ipfs_est - phala_est:.4f} NOVA)")
        
        return "Revoked (with Shade key rotate)"
    raise Exception(f"Revoke failed (check owner auth): {result.status}. Authentication required: Provide your account_id and private_key as the smart contract owner. Or deploy your own contract via `near deploy` and pass `contract_id`.")


@mcp.tool
async def get_shade_key(group_id: str, user_id: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> str:
    """Retrieves symmetric key from Shade TEE for authorized user. Provide creds as member."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or user_id
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    return await _get_shade_key(group_id, user_id, contract_id, private_key)


@mcp.tool
async def record_near_transaction(group_id: str, user_id: str, file_hash: str, ipfs_hash: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> str:
    """Records file tx on NOVA contract (owner only), returns trans_id. Provide creds as owner if not using default."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    return await _record_near_transaction(group_id, user_id, file_hash, ipfs_hash, contract_id, account_id, private_key)

@mcp.tool
async def composite_upload(group_id: str, user_id: str, data: str, filename: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> dict:
    """Full upload: get_key → encrypt → IPFS pin → record tx (owner for record). Provide creds as owner/member."""
    contract_id = contract_id or os.environ["CONTRACT_ID"]
    account_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    
    # Est fees for claim + record
    claim_fee = await _estimate_fee(contract_id, "claim_token")
    # claim_dynamic = await _get_dynamic_fee(contract_id, "claim_token")
    
    record_fee = await _estimate_fee(contract_id, "record_transaction")
    # record_dynamic = await _get_dynamic_fee(contract_id, "record_transaction", file_size_gb=1.0)

    total_fee = claim_fee + record_fee
    gas_margin = 400_000_000_000_000  # 400 TGas for chain
    total_attach = total_fee + gas_margin
    
    try:
        # Step 1: Fetch key (uses _get_shade_key, which has startup)
        key = await _get_shade_key(group_id, user_id, contract_id, private_key)
        # Step 2: Encrypt data
        encrypted_b64 = _encrypt_data(data, key)
        # Step 3: Upload (direct)
        cid = _ipfs_upload(encrypted_b64, filename)
        # Step 4: Local hash
        file_hash = hashlib.sha256(base64.b64decode(data)).hexdigest()
        # Step 5: Blockchain record (uses _record_near_transaction, which needs startup—ensure it's added there if not)
        trans_id = await _record_near_transaction(group_id, user_id, file_hash, cid, contract_id, account_id, private_key)
        print(f"Composite success: CID={cid}, Trans={trans_id}, (total fee: {total_fee / 1e24:.4f} NEAR)")
        return {"cid": cid, "trans_id": trans_id, "file_hash": file_hash, "fee_breakdown": {"claim": claim_fee / 1e24, "record": record_fee / 1e24, "total": total_fee / 1e24}}
    except Exception as e:
        raise Exception(f"Composite upload failed: {str(e)}")

@mcp.tool
async def composite_retrieve(group_id: str, ipfs_hash: str, account_id: str = None, private_key: str = None, contract_id: str = None) -> dict:
    """Full retrieve: get_key (member) → fetch IPFS → decrypt. Returns {'decrypted_b64': str, 'file_hash': str (for verification)}."""
    contract_id = contract_id or os.environ["NOVA_CONTRACT_ID"]  # Aligned env
    user_id = account_id or os.environ.get("SIGNER_ACCOUNT_ID", "nova-sdk-4.testnet")  # Derive user_id
    private_key = _validate_near_key(private_key or os.environ.get("NEAR_PRIVATE_KEY", ""))
    if not ipfs_hash.startswith('Qm'):
        raise Exception(f"Invalid CID: {ipfs_hash}")
    try:
        # Step 1: Fetch key (member auth)
        est_claim_fee = await _estimate_fee(contract_id, "claim_token")
        key = await _get_shade_key(group_id, user_id, contract_id, private_key)  # Use user_id
        print(f"Retrieve fee: {est_claim_fee / 1e24:.4f} NEAR (key access)")
        # Step 2: Fetch from IPFS (use internal)
        encrypted_b64 = await _ipfs_retrieve(ipfs_hash)
        # Step 3: Decrypt (use internal)
        decrypted_b64 = _decrypt_data(encrypted_b64, key)
        # Step 4: Hash for verification (user-side compare to on-chain)
        decrypted_data = base64.b64decode(decrypted_b64)
        file_hash = hashlib.sha256(decrypted_data).hexdigest()
        print(f"Composite retrieve success: {len(decrypted_data)} bytes, hash={file_hash}")
        return {"decrypted_b64": decrypted_b64, "file_hash": file_hash, "fee_breakdown": {"claim": est_claim_fee / 1e24}}
    except Exception as e:
        raise Exception(f"Composite retrieve failed: {str(e)}")

@mcp.tool
async def auth_status(user_id: str, group_id: str = "test_group") -> dict:
    """Tool: Check user auth/groups on NOVA contract. Returns {'authorized': bool, 'groups': list[str], 'member_count': int}."""
    contract_id = os.environ["CONTRACT_ID"]
    rpc = os.environ["RPC_URL"]
    private_key = os.environ.get("NEAR_PRIVATE_KEY", "")  # Dummy for views
    try:
        acc = Account(user_id, private_key, rpc)
        await acc.startup()
        # Check authorized
        auth_result = await acc.view_function(
            contract_id=contract_id,
            method_name="is_authorized",
            args={"group_id": group_id, "user_id": user_id}
        )
        authorized = auth_result.result
        # List user's groups via transactions (filter unique; assume default if none)
        txs_result = await acc.view_function(
            contract_id=contract_id,
            method_name="get_transactions_for_group",
            args={"group_id": group_id, "user_id": user_id}  # Reuse for sample; expand to all if multi-view added
        )
        groups = list(set(tx["group_id"] for tx in txs_result.result)) if txs_result.result else [group_id]
        member_count = len(groups)
        print(f"Auth for {user_id} in {group_id}: authorized={authorized}, groups={groups}")
        return {"authorized": authorized, "groups": groups, "member_count": member_count}
    except Exception as e:
        if "Unauthorized" in str(e):
            return {"authorized": False, "groups": [], "member_count": 0}
        raise Exception(f"Auth query failed: {str(e)}")
    

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
    mcp.run(transport="http", host="127.0.0.1", port=8000)
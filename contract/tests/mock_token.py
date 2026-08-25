# nova/contract/tests/mock_token.py
import json
import base64
import time
import hashlib
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import hashes
import base58

# Your config (replace with real)
PRIVATE_KEY_FULL = ""  # Full ed25519:base58
USER_ID = "test_user.testnet"
GROUP_ID = "test_group"

# Step 1: Gen timestamp (ns) and nonce (sha256 of group+user+timestamp)
timestamp = int(time.time() * 1_000_000_000)  # Current ns approx
nonce_input = f"{GROUP_ID}{USER_ID}{timestamp}"
nonce = hashlib.sha256(nonce_input.encode()).hexdigest()[:16]  # Short for simplicity (contract takes full str)

# Step 2: Build payload JSON
payload_dict = {
    "group_id": GROUP_ID,
    "user_id": USER_ID,
    "nonce": nonce,
    "timestamp": timestamp
}
payload_str = json.dumps(payload_dict, separators=(',', ':'))  # Compact
payload_bytes = payload_str.encode('utf-8')
payload_b64 = base64.b64encode(payload_bytes).decode('utf-8')

# Step 3: Extract seed from privkey (base58 decode full 64 bytes, take first 32 as seed)
if not PRIVATE_KEY_FULL.startswith('ed25519:'):
    raise ValueError("Privkey must be ed25519:base58")
seed_b58 = PRIVATE_KEY_FULL[8:]
seed_bytes_full = base58.b58decode(seed_b58)
if len(seed_bytes_full) != 64:
    raise ValueError("Invalid seed length")
seed_bytes = seed_bytes_full[:32]  # Ed25519 seed

# Step 4: Sign payload_str bytes
private_key_obj = ed25519.Ed25519PrivateKey.from_private_bytes(seed_bytes)
sig_bytes = private_key_obj.sign(payload_bytes)  # Sign the UTF-8 bytes
sig_hex = sig_bytes.hex()  # 64 hex chars

# Output for CLI
print(f"Payload B64: {payload_b64}")
print(f"Signature Hex: {sig_hex}")
print(f"Timestamp: {timestamp} (valid ~5min from now)")
print(f"Nonce: {nonce}")
print("\nUse in near call:")
print(f'near call nova-sdk-4.testnet claim_token "{{\\"group_id\\": \\"{GROUP_ID}\\", \\"payload_b64\\": \\"{payload_b64}\\", \\"signature_hex\\": \\"{sig_hex}\\"}}" --accountId {USER_ID} --gas 300000000000000')
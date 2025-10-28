import json
import time
import hashlib
import base64
import base58
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization

# Your vars (match MCP .env)
group_id = "test_group"  # Known group
user_id = "user.testnet" # Known user
private_key_full = "your_full_private_key_here"  # ed25519

# Step 0: Gen payload (exact MCP: compact JSON, ns timestamp, sha256 nonce)
timestamp_ns = int(time.time() * 1_000_000_000)  # ns approx (run close to claim for freshness)
nonce_input = f"{group_id}{user_id}{timestamp_ns}"
nonce = hashlib.sha256(nonce_input.encode()).hexdigest()
payload_dict = {
    "group_id": group_id,
    "user_id": user_id,
    "nonce": nonce,
    "timestamp": timestamp_ns
}
payload_str = json.dumps(payload_dict, separators=(',', ':'))  # Compact: no spaces/extra
payload_bytes = payload_str.encode('utf-8')
payload_b64 = base64.b64encode(payload_bytes).decode('utf-8')

print(f"Payload JSON str: {payload_str}")
print(f"Payload b64: {payload_b64}")
print(f"Nonce: {nonce}")
print(f"Timestamp ns: {timestamp_ns}")

# Step 1: Sign (fixed: decode full, slice first 32 as seed—handles 64-byte exports)
if private_key_full.startswith('ed25519:'):
    seed_b58 = private_key_full[8:]
    seed_bytes_full = base58.b58decode(seed_b58)
    if len(seed_bytes_full) < 32:
        raise ValueError(f"Decoded too short: {len(seed_bytes_full)} (need >=32 bytes)")
    seed_bytes = seed_bytes_full[:32]  # First 32 as ed25519 seed (standard for full exports)
    print(f"Full decode len: {len(seed_bytes_full)}, using seed len: {len(seed_bytes)}")
else:
    raise ValueError("Invalid privkey format")
private_key_obj = ed25519.Ed25519PrivateKey.from_private_bytes(seed_bytes)  # Use sliced 32
sig_bytes = private_key_obj.sign(payload_bytes)  # Sign raw bytes (matches contract)
sig_hex = sig_bytes.hex()  # 128 hex chars (64 bytes)

# Self-verify (debug: should always pass)
try:
    private_key_obj.public_key().verify(sig_bytes, payload_bytes)
    print("Self-verify raw: SUCCESS")
except Exception as e:
    print(f"Self-verify failed: {e} — sig gen bug!")

# Optional: Print derived pub for manual check (compare to near keys query)
try:
    pub_raw = private_key_obj.public_key().public_bytes(
        ed25519.Ed25519PublicKeyAlgorithm(), 
        ed25519.Encoding.Raw, 
        ed25519.PublicFormat.Raw
    )
    pub_b58 = base58.b58encode(pub_raw).decode()
    payload_dict["public_key"] = f"ed25519:{pub_b58}"
    print(f"Derived pub b58: ed25519:{pub_b58}")
except Exception as e:
    print(f"Pub derivation skipped (non-critical): {e}")

print(f"Sig hex: {sig_hex}")
print("\nArgs for claim_token:")
print(json.dumps({
    "group_id": group_id,
    "payload_b64": payload_b64,
    "signature_hex": sig_hex
}, indent=2))
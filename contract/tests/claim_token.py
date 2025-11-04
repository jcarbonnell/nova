import asyncio
import base64
import json
import hashlib
import time
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives import serialization
import base58
from py_near.account import Account  # Assume installed locally

async def test_claim_token():
    rpc = "https://rpc.testnet.near.org"
    contract_id = "nova-sdk-5.testnet"
    user_id = "nova-sdk-5.testnet"
    private_key = "your_private_key"  # Replace
    group_id = "test-group-1"
    acc = Account(user_id, private_key, rpc)
    await acc.startup()
    
    timestamp = int(time.time() * 1_000_000_000)
    nonce_input = f"{group_id}{user_id}{timestamp}"
    nonce = hashlib.sha256(nonce_input.encode()).hexdigest()
    payload_dict = {"group_id": group_id, "user_id": user_id, "nonce": nonce, "timestamp": timestamp}
    
    # Derive PK
    if private_key.startswith('ed25519:'):
        seed_b58 = private_key[8:]
        seed_bytes_full = base58.b58decode(seed_b58)
        seed_bytes = seed_bytes_full[:32]
        private_key_obj = ed25519.Ed25519PrivateKey.from_private_bytes(seed_bytes)
    public_bytes = private_key_obj.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    # Simple base58 (use lib)
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(public_bytes, 'big')
    res = []
    while n > 0:
        n, r = divmod(n, 58)
        res.append(alphabet[r])
    res.reverse()
    for byte in public_bytes:
        if byte == 0:
            res.insert(0, alphabet[0])
        else:
            break
    signing_pk_b58 = ''.join(res)
    payload_dict["signing_pk_b58"] = signing_pk_b58
    
    payload_str = json.dumps(payload_dict)
    payload_bytes = payload_str.encode('utf-8')
    payload_b64 = base64.b64encode(payload_bytes).decode('utf-8')
    sig_bytes = private_key_obj.sign(payload_bytes)
    sig_hex = sig_bytes.hex()
    
    est_fee = await acc.view_function(contract_id, "estimate_fee", {"action": "claim_token"})
    est_fee_int = int(est_fee.result)
    total_attach = est_fee_int + 100_000_000_000_000  # Margin
    result = await acc.function_call(
        contract_id, "claim_token",
        {"group_id": group_id, "payload_b64": payload_b64, "signature_hex": sig_hex},
        amount=total_attach, gas=100_000_000_000_000
    )
    print("Claim result:", result.status)
    print("Logs:", result.receipts_outcome[0].outcome.logs if result.receipts_outcome else "No logs")

asyncio.run(test_claim_token())
import asyncio
from server import _get_group_key, _encrypt_data, _ipfs_upload, _ipfs_retrieve, _decrypt_data, _record_near_transaction  # Import internals
import hashlib
import os
import random  # For mock noise

async def tee_federated_learning():
    group_id = "health_group"
    user_id = "YOUR_ACCOUNT_ID"
    contract_id = os.environ["CONTRACT_ID"]
    private_key = os.environ["NEAR_PRIVATE_KEY"]
    
    # Step 1: Upload encrypted dataset to NOVA (composite logic)
    dataset_b64 = 'c2Vuc2l0aXZlX2hlYWx0aF9yZWNvcmRzLmNzdg=='  # Mock b64
    key = await _get_group_key(group_id, user_id, contract_id, private_key)
    encrypted_b64 = _encrypt_data(dataset_b64, key)
    cid = _ipfs_upload(encrypted_b64, "records.csv")
    file_hash = hashlib.sha256(base64.b64decode(dataset_b64)).hexdigest()
    trans_id = await _record_near_transaction(group_id, user_id, file_hash, cid, contract_id, user_id, private_key)
    print(f"Uploaded to NOVA: CID {cid}")
    
    # Step 2: Mock TEE (pseudo-enclave: load, process with noise)
    encrypted_b64 = await _ipfs_retrieve(cid)
    decrypted_b64 = _decrypt_data(encrypted_b64, key)
    processed = base64.b64decode(decrypted_b64) + bytes(random.getrandbits(8) for _ in range(16))  # Noise
    processed = b"TEE fine-tuned: " + processed  # Mock output
    processed_b64 = base64.b64encode(processed).decode('utf-8')
    
    # Step 3: Store output back to NOVA
    encrypted_output = _encrypt_data(processed_b64, key)
    output_cid = _ipfs_upload(encrypted_output, "fine_tuned_model.json")
    output_hash = hashlib.sha256(processed).hexdigest()
    output_trans_id = await _record_near_transaction(group_id, user_id, output_hash, output_cid, contract_id, user_id, private_key)
    print(f"Output stored: CID {output_cid}")

if __name__ == "__main__":
    asyncio.run(tee_federated_learning())
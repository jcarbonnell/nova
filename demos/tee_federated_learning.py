import os
import time
import base64
import secrets  # For random noise
import requests
import json
from dotenv import load_dotenv

load_dotenv()

MCP_BASE_URL = "https://nova-mcp.fastmcp.app/mcp"  # Your live server
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"  # For MCP compatibility
}

_request_id = 0  # Global counter for JSON-RPC IDs

def call_mcp_tool(tool_name: str, params: dict) -> dict:
    """Call MCP tool via JSON-RPC POST, parsing SSE if needed."""
    global _request_id
    _request_id += 1
    payload = {
        "jsonrpc": "2.0",
        "id": _request_id,
        "method": tool_name,
        "params": params
    }
    print(f"Calling tool '{tool_name}' with payload: {json.dumps(payload, indent=2)[:300]}...")
    response = requests.post(
        MCP_BASE_URL,  # POST to /mcp (JSON-RPC)
        headers=HEADERS,
        json=payload,
        timeout=60,
        stream=True  # Enable streaming for SSE
    )
    print(f"Status Code: {response.status_code}")
    if response.status_code != 200:
        raise Exception(f"MCP tool '{tool_name}' failed: {response.status_code} - {response.text}")

    # Parse SSE response (extract 'data:' lines)
    result = None
    error_data = None
    for line in response.iter_lines(decode_unicode=True):
        if line and line.startswith('data: '):
            try:
                data_str = line[6:].strip()  # Remove 'data: '
                if data_str:
                    event_data = json.loads(data_str)
                    print(f"Parsed event data: {event_data}")  # Log
                    if "result" in event_data:
                        result = event_data["result"]
                    elif "error" in event_data:
                        error = event_data["error"]
                        error_data = error.get("data", "")  # Log 'data' field
                        raise Exception(f"MCP tool '{tool_name}' error: {error['message']} (code: {error['code']}, data: {error_data})")
                    else:
                        result = event_data
            except json.JSONDecodeError as e:
                print(f"Event JSON error: {e}")
                continue
        elif line == '':
            break  # End of SSE

    if result is None:
        raise Exception(f"MCP tool '{tool_name}' returned no valid data (error data: {error_data})")

    return result

def main():
    rpc = os.environ["RPC_URL"]  # Not directly used; for context
    contract = os.environ["CONTRACT_ID"]
    private_key = os.environ["NEAR_PRIVATE_KEY"]
    account_id = os.environ["SIGNER_ACCOUNT_ID"]

    # Strip prefix from private_key if present (server expects raw base58)
    if private_key.startswith("ed25519:"):
        private_key = private_key[8:]

    print(f"Account ID: {account_id}")

    # Step 0: Define group ID
    group_id = "tee_demo_healthcare"

    # Step 1: Upload encrypted dataset to NOVA via MCP tool
    dataset_b64 = base64.b64encode(b"patient_id,name,diagnosis\n1,Alice,hypertension\n2,Bob,diabetes\n3,Carol,asthma").decode('utf-8')
    upload_params = {
        "group_id": group_id,
        "user_id": account_id,
        "data": dataset_b64,  # Base64 CSV
        "filename": "health_records.csv",
        "account_id": account_id,  # For auth
        "private_key": private_key,  # Stripped
        "contract_id": contract
    }
    upload = call_mcp_tool("composite_upload", upload_params)
    print(f"Uploaded to NOVA: CID {upload['cid']}")

    # Wait for pin propagation
    print("Waiting 30s for IPFS pin to propagate...")
    time.sleep(30)

    # Step 2: Mock TEE (pseudo-enclave: retrieve via MCP, process with noise)
    retrieve_params = {
        "group_id": group_id,
        "ipfs_hash": upload['cid'],
        "account_id": account_id,
        "private_key": private_key,  # Stripped
        "contract_id": contract
    }
    retrieve = call_mcp_tool("composite_retrieve", retrieve_params)
    processed = base64.b64decode(retrieve['decrypted_b64'])  # Decrypted bytes
    noise = secrets.token_bytes(16)  # Simulate inference noise
    processed += noise
    processed = b"TEE fine-tuned: " + processed  # Mock output
    processed_b64 = base64.b64encode(processed).decode('utf-8')

    # Step 3: Store output back to NOVA via MCP tool
    output_params = {
        "group_id": group_id,
        "user_id": account_id,
        "data": processed_b64,
        "filename": "fine_tuned_model.json",
        "account_id": account_id,
        "private_key": private_key,  # Stripped
        "contract_id": contract
    }
    output_upload = call_mcp_tool("composite_upload", output_params)
    print(f"Output stored: CID {output_upload['cid']}")

if __name__ == "__main__":
    main()
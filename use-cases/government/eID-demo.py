import os
import time
import base64
import secrets  # For secure random mock data
from dotenv import load_dotenv

load_dotenv()

# Environment variables
RPC_URL = os.getenv('RPC_URL', 'https://rpc.testnet.near.org')
CONTRACT_ID = os.getenv('CONTRACT_ID', 'nova-contract.testnet')
IPFS_API_KEY = os.getenv('IPFS_API_KEY')
IPFS_API_SECRET = os.getenv('IPFS_API_SECRET')  # Not directly used in MCP, but kept for compatibility
CITIZEN_PRIVATE_KEY = os.getenv('CITIZEN_PRIVATE_KEY')
CITIZEN_ACCOUNT_ID = os.getenv('CITIZEN_ACCOUNT_ID')  # e.g., citizen.testnet
SERVANT_PRIVATE_KEY = os.getenv('SERVANT_PRIVATE_KEY')
SERVANT_ACCOUNT_ID = os.getenv('SERVANT_ACCOUNT_ID')  # e.g., servant.testnet
MCP_URL = os.getenv('MCP_URL', 'https://nova-mcp.fastmcp.app/mcp')  # Live public MCP server

required_vars = [CITIZEN_PRIVATE_KEY, CITIZEN_ACCOUNT_ID, SERVANT_PRIVATE_KEY, SERVANT_ACCOUNT_ID, IPFS_API_KEY]
if not all(required_vars):
    raise ValueError('Missing required env vars: CITIZEN_PRIVATE_KEY, CITIZEN_ACCOUNT_ID, SERVANT_PRIVATE_KEY, SERVANT_ACCOUNT_ID, IPFS_API_KEY')

print(f'Citizen Account: {CITIZEN_ACCOUNT_ID}')
print(f'Public Servant Account: {SERVANT_ACCOUNT_ID}')

def call_mcp_tool(tool_name: str, args: dict, account_id: str = None, private_key: str = None) -> dict:
    """Generic helper to call any NOVA MCP tool with optional signer authentication."""
    import requests
    import json

    url = MCP_URL
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000),
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args
        }
    }

    # Add signer info if provided (required for state-changing operations)
    if account_id and private_key:
        payload["params"]["arguments"].update({
            "account_id": account_id,
            "private_key": private_key,
            "contract_id": CONTRACT_ID
        })

    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}

    response = requests.post(url, json=payload, headers=headers, timeout=120, stream=True)
    if response.status_code != 200:
        response.raise_for_status()

    # Handle SSE streaming (most MCP tools return via SSE)
    events = []
    for line in response.iter_lines(decode_unicode=True):
        if line and line.startswith('data: '):
            try:
                event_data = json.loads(line[6:])
                events.append(event_data)
            except json.JSONDecodeError:
                continue

    if not events:
        raise Exception("Empty response from MCP server")

    # Use the last meaningful event
    result_event = events[-1]
    if 'error' in result_event:
        raise Exception(f"MCP error: {result_event['error']}")

    result = result_event.get('result', {})
    if result.get('isError'):
        error_text = result.get('content', [{}])[0].get('text', 'Unknown error')
        raise Exception(f"Tool error: {error_text}")

    # Prefer structuredContent, fallback to parsed text
    if 'structuredContent' in result:
        return result['structuredContent']
    elif 'content' in result and result['content']:
        text = result['content'][0].get('text', '{}')
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {'text': text}
    else:
        return result

# === eID Use Case Demo Starts Here ===

# Unique personal group for the citizen
group_id = f"myID.{CITIZEN_ACCOUNT_ID}"
print(f"\n=== Step 1: Citizen creates personal group and uploads national ID once ===")

# Create personal group (citizen is the only initial member)
create_group_args = {
    "group_id": group_id,
    "initial_members": [CITIZEN_ACCOUNT_ID]
}
try:
    call_mcp_tool('create_group', create_group_args, CITIZEN_ACCOUNT_ID, CITIZEN_PRIVATE_KEY)
    print(f"Personal group created: {group_id}")
except Exception as e:
    if "already exists" in str(e).lower():
        print(f"Group {group_id} already exists — continuing (safe for reruns)")
    else:
        print(f"Group creation warning: {e} — continuing")

# Simulate a national ID document (1MB random data representing a PDF/image)
id_document_data = secrets.token_bytes(1024 * 1024)  # 1MB mock PDF
filename = "national-id-document.pdf"

# Upload encrypted ID document once
upload_args = {
    "group_id": group_id,
    "user_id": CITIZEN_ACCOUNT_ID,
    "data": base64.b64encode(id_document_data).decode('utf-8'),
    "filename": filename
}
upload_result = call_mcp_tool('composite_upload', upload_args, CITIZEN_ACCOUNT_ID, CITIZEN_PRIVATE_KEY)

if 'cid' not in upload_result:
    raise Exception(f"Upload failed: {upload_result}")

print(f"Encrypted national ID uploaded to IPFS: CID = {upload_result['cid']}")
print(f"On-chain hash: {upload_result.get('hash', 'N/A')}")

# Wait for IPFS pinning
print("Waiting 15s for IPFS pin to propagate...")
time.sleep(15)

print(f"\n=== Step 2: Citizen grants temporary access to public servant ===")
add_member_args = {
    "group_id": group_id,
    "member_id": SERVANT_ACCOUNT_ID
}
call_mcp_tool('add_member', add_member_args, CITIZEN_ACCOUNT_ID, CITIZEN_PRIVATE_KEY)
print(f"Access granted: {SERVANT_ACCOUNT_ID} added to group")

# Allow time for TEE key propagation
time.sleep(5)

print(f"\n=== Step 3: Public servant retrieves and verifies the ID document ===")
retrieve_args = {
    "group_id": group_id,
    "ipfs_hash": upload_result['cid']
}
retrieve_result = call_mcp_tool('composite_retrieve', retrieve_args, SERVANT_ACCOUNT_ID, SERVANT_PRIVATE_KEY)

if 'decrypted_b64' not in retrieve_result:
    raise Exception(f"Retrieve failed: {retrieve_result}")

decrypted_data = base64.b64decode(retrieve_result['decrypted_b64'])
integrity_valid = retrieve_result.get('hash') == upload_result.get('hash')

print(f"ID document retrieved successfully. Length: {len(decrypted_data)} bytes")
print(f"Integrity valid: {integrity_valid}")

if integrity_valid:
    print("Public servant: National ID verified — service can now be provided.")

print(f"\n=== Step 4: Citizen revokes access after service completion ===")
remove_member_args = {
    "group_id": group_id,
    "member_id": SERVANT_ACCOUNT_ID
}
call_mcp_tool('remove_member', remove_member_args, CITIZEN_ACCOUNT_ID, CITIZEN_PRIVATE_KEY)
print(f"Access revoked: {SERVANT_ACCOUNT_ID} removed from group (keys rotated in TEEs)")

# Demonstrate revocation
print("Attempting retrieval after revocation (should fail)...")
try:
    call_mcp_tool('composite_retrieve', retrieve_args, SERVANT_ACCOUNT_ID, SERVANT_PRIVATE_KEY)
    print("Warning: Retrieval succeeded (possible short-term TEE caching in demo)")
except Exception as e:
    print(f"Revocation successful: Retrieval failed as expected → {e}")

print("\n=== eID Use Case Demo Complete ===")
print("Citizen maintains full sovereignty with NOVA:")
print("- One-time encrypted upload of national ID")
print("- Temporary, revocable access for public servants")
print("- No permanent exposure — privacy preserved via TEE key management")
print("- All actions auditable on NEAR blockchain")
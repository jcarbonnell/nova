import os
import time
import base64
import json
from dotenv import load_dotenv

load_dotenv()

# Environment variables
RPC_URL = os.getenv('RPC_URL', 'https://rpc.testnet.near.org')
CONTRACT_ID = os.getenv('CONTRACT_ID', 'nova-contract.testnet')
IPFS_API_KEY = os.getenv('IPFS_API_KEY')
IPFS_API_SECRET = os.getenv('IPFS_API_SECRET')  # Optional for MCP
MCP_URL = os.getenv('MCP_URL', 'https://nova-mcp.fastmcp.app/mcp')  # Live public MCP server

USER_PRIVATE_KEY = os.getenv('USER_PRIVATE_KEY')
USER_ACCOUNT_ID = os.getenv('USER_ACCOUNT_ID')  # e.g., user.testnet

required_vars = [USER_PRIVATE_KEY, USER_ACCOUNT_ID, IPFS_API_KEY]
if not all(required_vars):
    raise ValueError('Missing required env vars: USER_PRIVATE_KEY, USER_ACCOUNT_ID, IPFS_API_KEY')

print(f'User Account: {USER_ACCOUNT_ID}')

def call_mcp_tool(tool_name: str, args: dict, account_id: str = None, private_key: str = None) -> dict:
    """Generic helper to call any NOVA MCP tool with optional signer authentication."""
    import requests

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

    # Add signer info if provided
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

    # Handle SSE streaming
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

    result_event = events[-1]
    if 'error' in result_event:
        raise Exception(f"MCP error: {result_event['error']}")

    result = result_event.get('result', {})
    if result.get('isError'):
        error_text = result.get('content', [{}])[0].get('text', 'Unknown error')
        raise Exception(f"Tool error: {error_text}")

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

# === DCA History Use Case Demo Starts Here ===

# Unique personal group for DCA history
group_id = f"dca-history.{USER_ACCOUNT_ID}"
print(f"\n=== Step 1: Create or load personal DCA history group ===")

# Create personal group (user is the only initial member)
create_group_args = {
    "group_id": group_id,
    "initial_members": [USER_ACCOUNT_ID]
}
try:
    call_mcp_tool('create_group', create_group_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)
    print(f"Personal group created: {group_id}")
except Exception as e:
    if "already exists" in str(e).lower():
        print(f"Group {group_id} already exists — continuing")
    else:
        print(f"Group creation warning: {e} — continuing")

# Filename for the history file
filename = "dca-history.json"

# For demo: Assume no previous CID; upload initial sample history
# In real app: Track latest CID in local storage/DB
latest_cid = None

if latest_cid is None:
    # Sample initial history
    initial_history = [
        {
            "date": "17-12-2025",
            "operation": "Staked 2790 NEAR for 1,909 stNEAR.",
            "provider": "https://staking.metapool.app/",
            "portfolio": "5.12 NEAR, 1,909 stNEAR.",
            "rationale": "Chose metapool for its reliability + the tradeable stNEAR tokens."
        }
    ]
    initial_json = json.dumps(initial_history)
    initial_data_b64 = base64.b64encode(initial_json.encode('utf-8')).decode('utf-8')

    upload_args = {
        "group_id": group_id,
        "user_id": USER_ACCOUNT_ID,
        "data": initial_data_b64,
        "filename": filename
    }
    upload_result = call_mcp_tool('composite_upload', upload_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)

    if 'cid' not in upload_result:
        raise Exception(f"Initial upload failed: {upload_result}")

    latest_cid = upload_result['cid']
    print(f"Initial DCA history uploaded to IPFS: CID = {latest_cid}")

# Wait for IPFS pinning
print("Waiting 15s for IPFS pin to propagate...")
time.sleep(15)

print(f"\n=== Step 2: Retrieve latest DCA history for weekly update ===")

retrieve_args = {
    "group_id": group_id,
    "ipfs_hash": latest_cid
}
retrieve_result = call_mcp_tool('composite_retrieve', retrieve_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)

if 'decrypted_b64' not in retrieve_result:
    raise Exception(f"Retrieve failed: {retrieve_result}")

decrypted_json = base64.b64decode(retrieve_result['decrypted_b64']).decode('utf-8')
history = json.loads(decrypted_json)
print(f"Latest history retrieved: {len(history)} entries")
if history:
    print(f"Last portfolio: {history[-1]['portfolio']}")
else:
    print("History empty")

print(f"\n=== Step 3: Append new weekly DCA operation and re-upload ===")

# Simulate new weekly entry (from user input or DeFi integration)
new_entry = {
    "date": "31-12-2025",
    "operation": "Swapped 50-worth-usd of NEAR for ETH.",
    "provider": "https://dex.example.com",
    "portfolio": "4.5 NEAR, 1,800 stNEAR, 0.8 SOL, 0.001 BTC, 0.05 ETH",
    "rationale": "Diversifying into ETH ahead of expected market recovery."
}
history.append(new_entry)

updated_json = json.dumps(history)
updated_data_b64 = base64.b64encode(updated_json.encode('utf-8')).decode('utf-8')

update_upload_args = {
    "group_id": group_id,
    "user_id": USER_ACCOUNT_ID,
    "data": updated_data_b64,
    "filename": filename
}
update_upload_result = call_mcp_tool('composite_upload', update_upload_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)

if 'cid' not in update_upload_result:
    raise Exception(f"Update upload failed: {update_upload_result}")

latest_cid = update_upload_result['cid']
print(f"Updated DCA history re-uploaded to IPFS: New CID = {latest_cid}")

# Wait for propagation
time.sleep(15)

print(f"\n=== Step 4: Make data available to Shade Agent for confidential analysis ===")

# Temporarily add Shade Agent for access (use actual in prod)
agent_account_id = "shade-agent.testnet"
add_member_args = {
    "group_id": group_id,
    "member_id": agent_account_id
}
call_mcp_tool('add_member', add_member_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)
print(f"Shade Agent added temporarily: {agent_account_id}")

# Simulate agent retrieval and analysis (in real: invoke agent via MCP/API)
# For demo: Retrieve as user, mock analysis
agent_retrieve_result = call_mcp_tool('composite_retrieve', retrieve_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)  # Update retrieve_args if needed
agent_decrypted = base64.b64decode(agent_retrieve_result['decrypted_b64']).decode('utf-8')
agent_history = json.loads(agent_decrypted)

# Mock TEE analysis
mock_risk = "Medium"
mock_suggestion = "Increase BTC exposure by 20% for better diversification."
print(f"Agent analysis (mock): Portfolio risk: {mock_risk}; Suggestion: {mock_suggestion}")
print("Self-learning loop: Agent could fine-tune model on history for future recommendations.")

# Revoke agent access
remove_member_args = {
    "group_id": group_id,
    "member_id": agent_account_id
}
call_mcp_tool('remove_member', remove_member_args, USER_ACCOUNT_ID, USER_PRIVATE_KEY)
print(f"Agent access revoked: Keys rotated.")

print("\n=== DCA History Use Case Demo Complete ===")
print("Personal trading assistant data layer:")
print("- Secure, versioned DCA memos")
print("- Privacy-preserving access for AI agents")
print("- Ready for confidential portfolio analysis and self-learning")
import os
import time
import base64
import hashlib
import requests
import json
import secrets  # For secure random
from dotenv import load_dotenv

load_dotenv()

# Env vars
RPC_URL = os.getenv('RPC_URL')
CONTRACT_ID = os.getenv('CONTRACT_ID')
IPFS_API_KEY = os.getenv('IPFS_API_KEY')
IPFS_API_SECRET = os.getenv('IPFS_API_SECRET')
NEAR_PRIVATE_KEY = os.getenv('NEAR_PRIVATE_KEY')
SIGNER_ACCOUNT_ID = os.getenv('SIGNER_ACCOUNT_ID')
PARTICIPANT_KEY = os.getenv('PARTICIPANT_KEY')
PARTICIPANT_ACCOUNT = os.getenv('PARTICIPANT_ACCOUNT')
MCP_URL = os.getenv('MCP_URL', 'https://nova-mcp.fastmcp.app/mcp')  # Live MCP

if not all([RPC_URL, CONTRACT_ID, IPFS_API_KEY, IPFS_API_SECRET, NEAR_PRIVATE_KEY, SIGNER_ACCOUNT_ID, PARTICIPANT_KEY, PARTICIPANT_ACCOUNT]):
    raise ValueError('Missing env vars: See .env template')

print(f'Primary Account ID (Hospital A): {SIGNER_ACCOUNT_ID}')
print(f'Secondary Account ID (Hospital B): {PARTICIPANT_ACCOUNT}')

def call_mcp_tool(tool_name: str, args: dict, account_id: str = None, private_key: str = None) -> dict:
    """Call MCP tool via JSON-RPC POST to base URL; auth via args if needed. Handles SSE streaming."""
    url = MCP_URL  # Base: https://nova-mcp.fastmcp.app/mcp
    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000) % 1000000,  # Unique ID
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args
        }
    }
    if account_id and private_key:
        payload["params"]["arguments"].update({
            "account_id": account_id,
            "private_key": private_key,
            "contract_id": CONTRACT_ID
        })
    
    headers = {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json'
    }
    
    print(f"Debug: Calling {tool_name} with ID {payload['id']}, args preview: { {k: v[:20] + '...' if len(str(v)) > 20 else v for k, v in args.items()} }")
    
    response = requests.post(url, json=payload, headers=headers, timeout=120, stream=True)
    
    print(f"Debug: Status {response.status_code}, Content-Type: {response.headers.get('Content-Type', 'unknown')}")
    
    if response.status_code != 200:
        response.raise_for_status()
    elif not response.headers.get('Content-Type', '').startswith('application/json'):
        # SSE parse
        events = []
        for line in response.iter_lines(decode_unicode=True):
            if line and line.startswith('data: '):
                try:
                    event_str = line[6:].strip()
                    event_data = json.loads(event_str)
                    events.append(event_data)
                    print(f"Debug SSE event: {event_data}")
                    if 'result' in event_data:
                        result = event_data['result']
                        print(f"Debug: Full result keys: {list(result.keys())}")
                        print(f"Debug: Full result: {result}")
                        
                        # Check for error
                        if result.get('isError'):
                            error_text = result.get('content', [{}])[0].get('text', 'Unknown error')
                            raise Exception(f'MCP tool error: {error_text}')
                        
                        # Return structuredContent if available, otherwise try to parse content
                        if 'structuredContent' in result:
                            return result['structuredContent']
                        elif 'content' in result and len(result['content']) > 0:
                            content_text = result['content'][0].get('text', '{}')
                            try:
                                return json.loads(content_text)
                            except json.JSONDecodeError:
                                return {'text': content_text}
                        else:
                            return result
                except json.JSONDecodeError as e:
                    print(f"Debug: SSE parse error: {e}")
                    continue
        
        if events:
            # Last event likely has result
            last_event = events[-1]
            if 'result' in last_event:
                result = last_event['result']
                print(f"Debug: Full result keys (last): {list(result.keys())}")
                print(f"Debug: Full result (last): {result}")
                
                # Check for error
                if result.get('isError'):
                    error_text = result.get('content', [{}])[0].get('text', 'Unknown error')
                    raise Exception(f'MCP tool error: {error_text}')
                
                # Return structuredContent if available
                if 'structuredContent' in result:
                    return result['structuredContent']
                elif 'content' in result and len(result['content']) > 0:
                    content_text = result['content'][0].get('text', '{}')
                    try:
                        return json.loads(content_text)
                    except json.JSONDecodeError:
                        return {'text': content_text}
                else:
                    return result
            elif 'error' in last_event:
                raise Exception(f'MCP RPC error: {last_event["error"]}')
            else:
                raise Exception(f'Unexpected SSE events: {events}')
        else:
            raise Exception('Empty SSE stream')
    else:
        # Direct JSON
        try:
            rpc_reply = response.json()
            if "result" in rpc_reply:
                result = rpc_reply["result"]
                print(f"Debug: Full result keys: {list(result.keys())}")
                print(f"Debug: Full result: {result}")
                
                # Check for error
                if result.get('isError'):
                    error_text = result.get('content', [{}])[0].get('text', 'Unknown error')
                    raise Exception(f'MCP tool error: {error_text}')
                
                # Return structuredContent if available
                if 'structuredContent' in result:
                    return result['structuredContent']
                elif 'content' in result and len(result['content']) > 0:
                    content_text = result['content'][0].get('text', '{}')
                    try:
                        return json.loads(content_text)
                    except json.JSONDecodeError:
                        return {'text': content_text}
                else:
                    return result
            elif "error" in rpc_reply:
                raise Exception(f'MCP RPC error: {rpc_reply["error"]}')
            else:
                raise Exception(f'Unexpected RPC reply: {rpc_reply}')
        except json.JSONDecodeError as e:
            raise Exception(f'JSON decode failed: {e}. Body preview: {response.text[:200]}')

# Step 0: Define group ID
group_id = 'tee_demo_healthcare'

# Step 1: Hospital A uploads encrypted dataset to NOVA
dataset = b'patient_id,name,diagnosis\n1,Alice,hypertension\n2,Bob,diabetes\n3,Carol,asthma'  # CSV bytes
filename_a = 'health_records_a.csv'
upload_a_args = {
    'group_id': group_id,
    'user_id': SIGNER_ACCOUNT_ID,
    'data': base64.b64encode(dataset).decode(),
    'filename': filename_a
}
upload_a = call_mcp_tool('composite_upload', upload_a_args, SIGNER_ACCOUNT_ID, NEAR_PRIVATE_KEY)
if 'cid' not in upload_a:
    raise Exception(f"Upload failed - no CID in result: {upload_a}. Check key/auth/IPFS creds.")
print(f'Hospital A uploaded to NOVA: CID {upload_a["cid"]}')

# Wait for pin propagation
print('Waiting 30s for IPFS pin to propagate...')
time.sleep(30)

# Step 2: Hospital B retrieves and processes the data through the TEE
retrieve_b_args = {
    'group_id': group_id,
    'ipfs_hash': upload_a['cid']
}
retrieve_b = call_mcp_tool('composite_retrieve', retrieve_b_args, PARTICIPANT_ACCOUNT, PARTICIPANT_KEY)
if 'decrypted_b64' not in retrieve_b:
    raise Exception(f"Retrieve failed - no decrypted_b64 in result: {retrieve_b}")
decrypted_data = base64.b64decode(retrieve_b['decrypted_b64'])
noise_b = secrets.token_bytes(16)  # Simulate inference noise (secure random)
processed_b = b'TEE processed by B: ' + decrypted_data + noise_b

# Step 3: Hospital B stores output back to NOVA
output_upload_b_args = {
    'group_id': group_id,
    'user_id': PARTICIPANT_ACCOUNT,
    'data': base64.b64encode(processed_b).decode(),
    'filename': 'fine_tuned_model_b.json'
}
output_upload_b = call_mcp_tool('composite_upload', output_upload_b_args, PARTICIPANT_ACCOUNT, PARTICIPANT_KEY)
if 'cid' not in output_upload_b:
    raise Exception(f"Output upload failed - no CID in result: {output_upload_b}")
print(f'Hospital B output stored: CID {output_upload_b["cid"]}')

# Wait for pin propagation
print('Waiting 30s for IPFS pin to propagate...')
time.sleep(30)

# Step 4: Hospital A retrieves B's data, processes it, and uploads final output
retrieve_a_args = {
    'group_id': group_id,
    'ipfs_hash': output_upload_b['cid']
}
retrieve_a = call_mcp_tool('composite_retrieve', retrieve_a_args, SIGNER_ACCOUNT_ID, NEAR_PRIVATE_KEY)
if 'decrypted_b64' not in retrieve_a:
    raise Exception(f"Final retrieve failed - no decrypted_b64 in result: {retrieve_a}")
decrypted_a = base64.b64decode(retrieve_a['decrypted_b64'])
noise_a = secrets.token_bytes(16)  # Simulate final inference noise
final_processed = b'Final TEE aggregated by A: ' + decrypted_a + noise_a

final_upload_args = {
    'group_id': group_id,
    'user_id': SIGNER_ACCOUNT_ID,
    'data': base64.b64encode(final_processed).decode(),
    'filename': 'final_aggregated_model.json'
}
final_upload = call_mcp_tool('composite_upload', final_upload_args, SIGNER_ACCOUNT_ID, NEAR_PRIVATE_KEY)
if 'cid' not in final_upload:
    raise Exception(f"Final upload failed - no CID in result: {final_upload}")
print(f'Hospital A final output stored: CID {final_upload["cid"]}')

print('Federated learning demo completed successfully!')
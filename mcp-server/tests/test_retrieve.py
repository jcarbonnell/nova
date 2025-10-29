import asyncio
from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport
import base64

async def test_retrieve():
    transport = StreamableHttpTransport("http://127.0.0.1:8000/mcp")
    async with Client(transport) as client:
        # Use your uploaded CID
        result = await client.call_tool("ipfs_retrieve", {"cid": "QmWmsL95CYvci8JiortAMhezezr8BhAwAVohVUSJBcZcBL"})
        print("Raw Result:", result)
        print("Result Data:", result.data)  # Access .data for str result
        if result.data:
            data = base64.b64decode(result.data)
            print("Decoded:", data.decode('utf-8') if data else "Empty")

asyncio.run(test_retrieve())
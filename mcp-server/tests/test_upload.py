import asyncio
from fastmcp.client import Client
from fastmcp.client.transports import StreamableHttpTransport
import base64

async def test_upload():
    transport = StreamableHttpTransport("http://127.0.0.1:8000/mcp")
    async with Client(transport) as client:  # Auto-creates session
        # Call tool (data as str base64, as in curl)
        result = await client.call_tool(
            "ipfs_upload",
            {"data": "dGVzdCBkYXRh", "filename": "test.txt"}  # base64 "test data"
        )
        print("Result:", result)

asyncio.run(test_upload())
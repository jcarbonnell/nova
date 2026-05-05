// Test NOVA SDK with API key authentication
const API_KEY = 'nova_sk_JsPqb3RRkLXeAuOcCdxZWzPPjxQ65bRP8job4BAtsJc';
const ACCOUNT_ID = 'hello-partage.nova-sdk.near';
const MCP_BASE_URL = 'https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network';

async function testSessionToken() {
  console.log('🧪 Testing session token generation...\n');
  
  try {
    const response = await fetch('https://nova-sdk.com/api/auth/session-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Session token failed:', error);
      return null;
    }

    const data = await response.json();
    console.log('✅ Session token received');
    console.log('   Account:', data.account_id);
    console.log('   Token expires in:', data.expires_in);
    console.log('   Token preview:', data.token.substring(0, 50) + '...\n');
    
    return data.token;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

async function testGetOwnedGroups(sessionToken) {
  console.log('🧪 Testing get_owned_groups (REST endpoint)...\n');
  
  try {
    const response = await fetch(`${MCP_BASE_URL}/tools/get_owned_groups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'x-account-id': ACCOUNT_ID,
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      console.error('❌ Request failed with status:', response.status);
      const text = await response.text();
      console.error('   Error:', text.substring(0, 200));
      return;
    }

    const data = await response.json();
    
    if (data.error) {
      console.error('❌ API call failed:', data.error);
      return;
    }

    console.log('✅ get_owned_groups succeeded');
    console.log('   Result:', JSON.stringify(data.result, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function runTests() {
  console.log('═══════════════════════════════════════');
  console.log('   NOVA SDK Test Suite (REST API)');
  console.log('═══════════════════════════════════════\n');
  
  // Test 1: Get session token
  const sessionToken = await testSessionToken();
  
  if (!sessionToken) {
    console.log('❌ Cannot proceed without session token');
    return;
  }
  
  // Test 2: Call REST endpoint
  await testGetOwnedGroups(sessionToken);
  
  console.log('\n═══════════════════════════════════════');
  console.log('   Tests Complete');
  console.log('═══════════════════════════════════════');
}

runTests().catch(console.error);
// nova-sdk-rs v3 Example: Group Management
//
// Environment variables required:
//   TEST_NOVA_ACCOUNT_ID - Your NOVA-managed account (e.g., "alice-nova.nova-sdk-5.testnet")
//   TEST_SESSION_TOKEN   - JWT from nova-sdk.com/api/auth/session-token
//
// Run with: cargo run --example group_management

use nova_sdk_rs::NovaSdk;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load from env
    let account_id = env::var("TEST_NOVA_ACCOUNT_ID")
        .expect("TEST_NOVA_ACCOUNT_ID required (e.g., alice-nova.nova-sdk-5.testnet)");
    let session_token = env::var("TEST_SESSION_TOKEN")
        .expect("TEST_SESSION_TOKEN required (get from nova-sdk.com/api/auth/session-token)");
    
    let new_member = "test.member.testnet"; // Replace with a real test account

    // Initialize SDK (v3: account_id + session_token only)
    let sdk = NovaSdk::new(&account_id, &session_token)?;
    
    println!("🔧 SDK initialized for account: {}", sdk.account_id());
    println!("   Contract: {}", sdk.contract_id());
    println!("   MCP: {}", sdk.mcp_url());

    let group_id = "demo_group";

    // Check auth status first
    match sdk.auth_status(Some(group_id)).await {
        Ok(status) => {
            println!("\n🔍 Auth status:");
            println!("   Authenticated: {}", status.authenticated);
            println!("   Account: {:?}", status.near_account_id);
            println!("   Authorized for {}: {:?}", group_id, status.authorized_for_group);
        }
        Err(e) => println!("⚠️  Auth status check failed: {}", e),
    }

    // Register new group
    println!("\n📁 Registering group '{}'...", group_id);
    match sdk.register_group(group_id).await {
        Ok(msg) => println!("✅ {}", msg),
        Err(e) if e.to_string().contains("exists") || e.to_string().contains("already") => {
            println!("⚠️  Group '{}' already exists.", group_id)
        }
        Err(e) => {
            println!("❌ Registration failed: {}", e);
            // Continue anyway for demo
        }
    }

    // Add member
    println!("\n👤 Adding member '{}' to group '{}'...", new_member, group_id);
    match sdk.add_group_member(group_id, new_member).await {
        Ok(msg) => println!("✅ {}", msg),
        Err(e) if e.to_string().contains("already a member") => {
            println!("⚠️  '{}' is already a member.", new_member)
        }
        Err(e) => println!("❌ Add member failed: {}", e),
    }

    // Check authorization (direct RPC call - no MCP needed)
    println!("\n🔍 Checking authorization for '{}'...", new_member);
    match sdk.is_authorized(group_id, Some(new_member)).await {
        Ok(authorized) => println!("   Authorization: {}", if authorized { "✅ YES" } else { "❌ NO" }),
        Err(e) => println!("   Authorization check failed: {}", e),
    }

    // Revoke member (triggers key rotation in Shade TEE)
    println!("\n🚫 Revoking member '{}' from group '{}'...", new_member, group_id);
    match sdk.revoke_group_member(group_id, new_member).await {
        Ok(msg) => println!("✅ {} (key rotated)", msg),
        Err(e) if e.to_string().contains("not a member") => {
            println!("⚠️  '{}' is not a member.", new_member)
        }
        Err(e) => println!("❌ Revoke failed: {}", e),
    }

    // Verify revocation
    println!("\n🔍 Verifying revocation...");
    match sdk.is_authorized(group_id, Some(new_member)).await {
        Ok(authorized) => {
            if !authorized {
                println!("   ✅ Revocation confirmed - '{}' no longer authorized", new_member);
            } else {
                println!("   ⚠️  Revocation may have failed - '{}' still authorized", new_member);
            }
        }
        Err(e) => println!("   Authorization check failed: {}", e),
    }

    // Show group info
    println!("\n📊 Group info for '{}':", group_id);
    if let Ok(Some(owner)) = sdk.get_group_owner(group_id).await {
        println!("   Owner: {}", owner);
    }
    if let Ok(Some(checksum)) = sdk.get_group_checksum(group_id).await {
        println!("   Checksum: {}...", &checksum[..std::cmp::min(16, checksum.len())]);
    }

    println!("\n🎉 Group management demo complete.");
    Ok(())
}
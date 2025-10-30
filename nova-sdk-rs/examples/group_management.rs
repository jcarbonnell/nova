use nova_sdk_rs::NovaSdk;
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load from env
    let rpc_url = env::var("RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.near.org".to_string());
    let contract_id = env::var("CONTRACT_ID").unwrap_or_else(|_| "nova-sdk-4.testnet".to_string());  // Updated to v2
    let private_key = env::var("TEST_NEAR_PRIVATE_KEY").expect("TEST_NEAR_PRIVATE_KEY required");
    let account_id = env::var("TEST_NEAR_ACCOUNT_ID").expect("TEST_NEAR_ACCOUNT_ID required");
    let new_member = "test.member.testnet";  // Replace with a real test account

    // Initialize SDK (owner account) - v2 requires shade_api_url (dummy for non-Shade ops)
    let sdk = NovaSdk::new(
        &rpc_url, 
        &contract_id, 
        "dummy",  // pinata_key (unused here)
        "dummy",  // pinata_secret (unused here)
        "https://fake-shade.phala.network"  // shade_api_url (dummy; ignored in group ops)
    ).with_signer(&private_key, &account_id)?;

    let group_id = "demo_group";

    // Register new group
    match sdk.register_group(group_id).await {
        Ok(_) => println!("✅ Group '{}' registered.", group_id),
        Err(e) if e.to_string().contains("exists") => println!("⚠️ Group '{}' already exists.", group_id),
        Err(e) => return Err(e.into()),
    }

    // Add member
    sdk.add_group_member(group_id, new_member).await?;
    println!("✅ Added member '{}' to group '{}'.", new_member, group_id);

    // Check authorization
    let authorized = sdk.is_authorized(group_id, new_member).await?;
    println!("🔍 Authorization check for '{}': {}", new_member, authorized);

    // Revoke member
    sdk.revoke_group_member(group_id, new_member).await?;
    println!("✅ Revoked member '{}' from group '{}'.", new_member, group_id);

    // Verify revocation
    let authorized_after = sdk.is_authorized(group_id, new_member).await?;
    println!("🔍 Authorization after revoke: {}", authorized_after);
    assert!(!authorized_after, "Revocation failed!");

    println!("\n🎉 Group management demo complete.");
    Ok(())
}
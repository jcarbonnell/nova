use nova_sdk_rs::NovaSdk;
use std::env;
use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Load from env (with fallbacks)
    let rpc_url = env::var("RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.near.org".to_string());
    let contract_id = env::var("CONTRACT_ID").unwrap_or_else(|_| "nova-sdk-4.testnet".to_string());
    let shade_api_url = env::var("SHADE_API_URL").unwrap_or_else(|_| "https://fake-shade.phala.network".to_string()); // Parallel to JS
    let pinata_key = env::var("PINATA_API_KEY").unwrap_or_else(|_| "dummy".to_string()); // Dummy OK for demo
    let pinata_secret = env::var("PINATA_SECRET_KEY").unwrap_or_else(|_| "dummy".to_string());
    let private_key = env::var("TEST_NEAR_PRIVATE_KEY").expect("TEST_NEAR_PRIVATE_KEY required for signer");
    let account_id = env::var("TEST_NEAR_ACCOUNT_ID").expect("TEST_NEAR_ACCOUNT_ID required for signer");

    // Initialize SDK (v2: shade_api_url required)
    let sdk = NovaSdk::new(
        &rpc_url,
        &contract_id,
        &pinata_key,
        &pinata_secret,
        &shade_api_url,  // Now in scope
    )
    .with_signer(&private_key, &account_id)?;

    let group_id = "rotation_test";

    // Register group if not exists (triggers Shade key gen off-chain)
    if let Err(e) = sdk.register_group(group_id).await {
        if e.to_string().contains("Group exists") {
            println!("Group '{}' already exists; skipping registration.", group_id);
        } else {
            println!("Group registration failed (expected for demo): {}", e);
        }
    } else {
        println!("✅ Group '{}' registered; Shade key generated off-chain.", group_id);
    }

    // Fetch initial key (v2: token claim + Shade fetch + checksum verify)
    let initial_key = sdk.get_group_key(group_id, &account_id).await?;
    println!("🔑 Initial key retrieved: {}...", &initial_key[..std::cmp::min(20, initial_key.len())]);

    // Add a dummy member (for revocation demo)
    let dummy_member = "dummy_member.testnet";
    if let Err(e) = sdk.add_group_member(group_id, dummy_member).await {
        if e.to_string().contains("already a member") {
            println!("Dummy member already added; skipping.");
        } else {
            println!("Add member failed (expected if auth issue): {}", e);
        }
    } else {
        println!("✅ Dummy member added to group '{}'.", group_id);
    }

    // Simulate revocation (triggers Shade key rotation off-chain)
    let result = sdk.revoke_group_member(group_id, dummy_member).await;
    match result {
        Ok(_) => {
            println!("✅ Revocation triggered key rotation for group '{}'.", group_id);
        }
        Err(e) => {
            if e.to_string().contains("User not a member") || e.to_string().contains("not a member") {
                println!("Dummy member not present; skipping revocation (no rotation).");
            } else {
                println!("Revocation failed (expected for demo): {}", e);
            }
        }
    }

    // Fetch new key
    let rotated_key = sdk.get_group_key(group_id, &account_id).await?;
    println!("🔄 Rotated key retrieved: {}...", &rotated_key[..std::cmp::min(20, rotated_key.len())]);
    assert_ne!(rotated_key, initial_key, "Key should have rotated!");

    println!("\n🎉 Key rotation demo complete. Old key: {}..., New key: {}...", &initial_key[..std::cmp::min(20, initial_key.len())], &rotated_key[..std::cmp::min(20, rotated_key.len())]);
    Ok(())
}
use nova_sdk_rs::{NovaSdk, CompositeRetrieveResult, CompositeUploadResult};
use rand::{thread_rng, RngCore};
use std::error::Error;
use std::time::Duration;
use tokio::time::sleep;
use dotenv::dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();

    // Load environment variables
    let rpc = std::env::var("RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.near.org".to_string());
    let contract = std::env::var("CONTRACT_ID").unwrap_or_else(|_| "nova-contract.testnet".to_string());
    let pinata_key = std::env::var("IPFS_API_KEY")?;
    let pinata_secret = std::env::var("IPFS_API_SECRET")?;
    let shade_api_url = std::env::var("SHADE_API_URL")?;

    let citizen_private_key = std::env::var("CITIZEN_PRIVATE_KEY")?;
    let citizen_account_id = std::env::var("CITIZEN_ACCOUNT_ID")?; // e.g., citizen.testnet

    let servant_private_key = std::env::var("SERVANT_PRIVATE_KEY")?;
    let servant_account_id = std::env::var("SERVANT_ACCOUNT_ID")?; // e.g., servant.testnet

    println!("Citizen Account: {}", citizen_account_id);
    println!("Public Servant Account: {}", servant_account_id);

    // Initialize SDK for citizen and servant
    let citizen_sdk = NovaSdk::new(&rpc, &contract, &pinata_key, &pinata_secret, &shade_api_url)
        .with_signer(&citizen_private_key, &citizen_account_id)?;

    let servant_sdk = NovaSdk::new(&rpc, &contract, &pinata_key, &pinata_secret, &shade_api_url)
        .with_signer(&servant_private_key, &servant_account_id)?;

    // Unique personal group ID for this citizen
    let group_id = format!("myID.{}", citizen_account_id);
    println!("\n=== Step 1: Citizen creates personal group and uploads national ID once ===");

    // Create personal group (only citizen as initial member)
    match citizen_sdk.create_group(&group_id, &[&citizen_account_id]).await {
        Ok(_) => println!("Personal group created: {}", group_id),
        Err(e) => println!("Group may already exist or error: {}. Continuing...", e),
    }

    // Simulate a national ID document (e.g., 1MB fake PDF)
    // In a real app: read from file via std::fs::read("national-id.pdf")?
    let mut id_document_data = vec![0u8; 1024 * 1024]; // 1MB
    thread_rng().fill_bytes(&mut id_document_data);
    let filename = "national-id-document.pdf";

    // Upload encrypted ID document once
    let upload_result: CompositeUploadResult = citizen_sdk
        .composite_upload(&group_id, &citizen_account_id, &id_document_data, filename)
        .await?;
    println!("Encrypted national ID uploaded to IPFS: CID = {}", upload_result.cid);
    println!("On-chain hash: {}", upload_result.hash);

    // Wait for IPFS pin propagation
    println!("Waiting 15s for IPFS pin to propagate...");
    sleep(Duration::from_secs(15)).await;

    println!("\n=== Step 2: Citizen grants temporary access to public servant ===");

    // Citizen adds servant to their personal group
    citizen_sdk.add_member(&group_id, &servant_account_id).await?;
    println!("Access granted: {} added to group {}", servant_account_id, group_id);

    // Allow time for TEE key distribution
    sleep(Duration::from_secs(5)).await;

    println!("\n=== Step 3: Public servant retrieves and verifies the ID document ===");

    // Servant retrieves and decrypts the document via TEE-secured key
    let retrieved: CompositeRetrieveResult = servant_sdk
        .composite_retrieve(&group_id, &upload_result.cid)
        .await?;

    // Verify integrity by comparing hashes
    let is_valid = retrieved.hash == upload_result.hash;
    println!("ID document retrieved. Integrity valid: {}", is_valid);
    println!("Decrypted data length: {} bytes", retrieved.data.len());

    if is_valid {
        println!("Public servant: National ID verified — service can now be provided.");
    }

    println!("\n=== Step 4: Citizen revokes access after service completion ===");

    // Citizen removes servant from group (triggers key rotation in TEEs)
    citizen_sdk.remove_member(&group_id, &servant_account_id).await?;
    println!("Access revoked: {} removed from group", servant_account_id);

    // Demonstrate that revocation works
    println!("Attempting retrieval after revocation (should fail due to key rotation)...");
    match servant_sdk.composite_retrieve(&group_id, &upload_result.cid).await {
        Ok(_) => println!("Warning: Retrieval succeeded (possible TEE caching in short demo)"),
        Err(e) => println!("Revocation successful: Retrieval failed as expected: {}", e),
    }

    println!("\n=== eID Use Case Demo Complete ===");
    println!("Citizen maintains full sovereignty:");
    println!("- One-time encrypted upload");
    println!("- Temporary, revocable access for public servants");
    println!("- No permanent exposure of sensitive ID data");

    Ok(())
}
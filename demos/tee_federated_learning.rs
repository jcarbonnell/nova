use nova_sdk_rs::{NovaSdk, CompositeRetrieveResult, CompositeUploadResult};
use rand::{RngCore, thread_rng}; // For mock noise
use std::error::Error;
use std::time::Duration;
use tokio::time::sleep;
use dotenv::dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();
    let rpc = std::env::var("RPC_URL")?;
    let contract = std::env::var("CONTRACT_ID")?;
    let pinata_key = std::env::var("IPFS_API_KEY")?;
    let pinata_secret = std::env::var("IPFS_API_SECRET")?;
    let private_key_a = std::env::var("NEAR_PRIVATE_KEY")?;
    let account_id_a = std::env::var("SIGNER_ACCOUNT_ID")?;
    let private_key_b = std::env::var("PARTICIPANT_KEY")?;
    let account_id_b = std::env::var("PARTICIPANT_ACCOUNT")?;

    println!("Primary Account ID (Hospital A): {}", account_id_a);
    println!("Secondary Account ID (Hospital B): {}", account_id_b);

    // Init NOVA SDK for Hospital A
    let sdk_a = NovaSdk::new(
        &rpc,
        &contract,
        &pinata_key,
        &pinata_secret,
    )
    .with_signer(&private_key_a, &account_id_a)?;
    
    // Init NOVA SDK for Hospital B
    let sdk_b = NovaSdk::new(
        &rpc,
        &contract,
        &pinata_key,
        &pinata_secret,
    )
    .with_signer(&private_key_b, &account_id_b)?;
    
    // Step 0: Define group ID
    let group_id = "tee_demo_healthcare";

    // Step 1: Hospital A uploads encrypted dataset to NOVA
    let dataset = b"patient_id,name,diagnosis\n1,Alice,hypertension\n2,Bob,diabetes\n3,Carol,asthma"; // CSV bytes
    let filename_a = "health_records_a.csv";
    let upload_a: CompositeUploadResult = sdk_a.composite_upload(group_id, &account_id_a, dataset, filename_a).await?;
    println!("Hospital A uploaded to NOVA: CID {}", upload_a.cid);

    // Wait for pin propagation (fixes delay)
    println!("Waiting 30s for IPFS pin to propagate...");
    sleep(Duration::from_secs(30)).await;
    
    // Step 2: Hospital B retrieves and processes the data through the TEE
    let retrieve_b: CompositeRetrieveResult = sdk_b.composite_retrieve(group_id, &upload_a.cid).await?;
    let mut processed_b = retrieve_b.data.clone();
    let mut noise_b = [0u8; 16];
    thread_rng().fill_bytes(&mut noise_b); // Simulate inference noise
    processed_b.extend_from_slice(&noise_b);
    let processed_b = [&b"TEE processed by B: "[..], &processed_b].concat(); // Mock output
    
    // Step 3: Hospital B stores output back to NOVA
    let output_upload_b = sdk_b.composite_upload(group_id, &account_id_b, &processed_b, "fine_tuned_model_b.json").await?;
    println!("Hospital B output stored: CID {}", output_upload_b.cid);

    // Wait for pin propagation
    println!("Waiting 30s for IPFS pin to propagate...");
    sleep(Duration::from_secs(30)).await;
    
    // Step 4: Hospital A retrieves B's data, processes it, and uploads final output
    let retrieve_a: CompositeRetrieveResult = sdk_a.composite_retrieve(group_id, &output_upload_b.cid).await?;
    let mut processed_a = retrieve_a.data.clone();
    let mut noise_a = [0u8; 16];
    thread_rng().fill_bytes(&mut noise_a); // Simulate final inference noise
    processed_a.extend_from_slice(&noise_a);
    let final_processed = [&b"Final TEE aggregated by A: "[..], &processed_a].concat(); // Mock final output
    
    let final_upload = sdk_a.composite_upload(group_id, &account_id_a, &final_processed, "final_aggregated_model.json").await?;
    println!("Hospital A final output stored: CID {}", final_upload.cid);
    
    Ok(())
}
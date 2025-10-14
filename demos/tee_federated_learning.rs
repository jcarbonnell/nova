use nova_sdk_rs::{NovaSdk, CompositeRetrieveResult, CompositeUploadResult};
use rand::{RngCore, thread_rng}; // For mock noise
use std::error::Error;
use dotenv::dotenv;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();
    let rpc = std::env::var("RPC_URL")?;
    let contract = std::env::var("CONTRACT_ID")?;
    let pinata_key = std::env::var("IPFS_API_KEY")?;
    let pinata_secret = std::env::var("IPFS_API_SECRET")?;
    let private_key = std::env::var("NEAR_PRIVATE_KEY")?;
    let account_id = std::env::var("SIGNER_ACCOUNT_ID")?;

    println!("Account ID: {}", account_id);

    // Init NOVA SDK
    let sdk = NovaSdk::new(
        &rpc,
        &contract,
        &pinata_key,
        &pinata_secret,
    )
    .with_signer(&private_key, &account_id)
    .map_err(|e| {
        println!("With signer error: {:?}", e);
        e
    })?;
    
    // Step 1: Upload encrypted dataset to NOVA
    let dataset = b"sensitive_health_records.csv"; // Mock data
    let upload: CompositeUploadResult = sdk.composite_upload("tee_demo_healthcare", &account_id, dataset, "records.csv").await?;
    println!("Uploaded to NOVA: CID {}", upload.cid);
    
    // Step 2: Mock TEE (pseudo-enclave: load, process with noise)
    let retrieve: CompositeRetrieveResult = sdk.composite_retrieve("tee_demo_healthcare", &upload.cid).await?;
    let mut processed = retrieve.data.clone();
    let mut noise = [0u8; 16];
    thread_rng().fill_bytes(&mut noise); // Simulate inference noise
    processed.extend_from_slice(&noise);
    let processed = [&b"TEE fine-tuned: "[..], &processed].concat(); // Mock output
    
    // Step 3: Store output back to NOVA (with "attestation" as metadata)
    let output_upload = sdk.composite_upload("tee_demo_healthcare", &account_id, &processed, "fine_tuned_model.json").await?;
    println!("Output stored: CID {}", output_upload.cid);
    
    Ok(())
}
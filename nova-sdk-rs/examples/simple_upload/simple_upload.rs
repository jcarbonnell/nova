// examples/simple_upload.rs
// Test NOVA SDK upload/retrieve with client-side encryption
//
// Environment variables required:
//   TEST_NOVA_ACCOUNT_ID - Your NOVA-managed account (e.g., "alice.nova-sdk.near")
//   TEST_SESSION_TOKEN   - JWT from nova-sdk.com/api/auth/session-token
//
// Run with: cargo run --example simple_upload

use nova_sdk_rs::{NovaSdk, NovaSdkConfig};
use std::env;
use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Load from env
    let account_id = env::var("TEST_NOVA_ACCOUNT_ID")
        .expect("TEST_NOVA_ACCOUNT_ID required (e.g., alice.nova-sdk.near)");
    let session_token = env::var("TEST_SESSION_TOKEN")
        .expect("TEST_SESSION_TOKEN required (get from nova-sdk.com/api/auth/session-token)");

    // Optional: custom config for testnet
    let config = if account_id.contains("testnet") {
        NovaSdkConfig {
            rpc_url: "https://rpc.testnet.near.org".to_string(),
            contract_id: "nova-sdk-5.testnet".to_string(),
            mcp_url: "https://nova-mcp.fastmcp.app".to_string(),
        }
    } else {
        NovaSdkConfig::default() // Mainnet
    };

    // Initialize SDK
    let sdk = NovaSdk::with_config(&account_id, &session_token, config)?;
    
    println!("🔧 SDK initialized");
    println!("   Account: {}", sdk.account_id());
    println!("   Contract: {}", sdk.contract_id());
    println!("   Network: {}", sdk.network_id());
    println!("   MCP: {}", sdk.mcp_url());

    let group_id = "sdk_test_group_rs";

    // Check auth status
    println!("\n🔍 Checking authentication...");
    match sdk.auth_status(Some(group_id)).await {
        Ok(status) => {
            println!("   ✅ Authenticated: {}", status.authenticated);
            if let Some(acc) = &status.near_account_id {
                println!("   Account: {}", acc);
            }
            if let Some(auth) = status.authorized_for_group {
                println!("   Authorized for {}: {}", group_id, auth);
            }
        }
        Err(e) => {
            println!("   ❌ Auth failed: {}", e);
            return Err(e.into());
        }
    }

    // Ensure group exists
    println!("\n📁 Ensuring group '{}' exists...", group_id);
    match sdk.register_group(group_id).await {
        Ok(msg) => println!("   ✅ {}", msg),
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("exists") || err_str.contains("already") || err_str.contains("registered") {
                println!("   ⚠️  Group already exists (OK)");
            } else {
                println!("   ⚠️  Registration: {} (continuing anyway)", e);
            }
        }
    }

    // Prepare test data
    let test_data = b"Hello from NOVA SDK Rust v1.0! \xF0\x9F\x94\x90 Client-side encrypted on IPFS.";
    let filename = "hello_sdk_test_rs.txt";
    
    println!("\n📤 Uploading file (client-side encryption)...");
    println!("   Filename: {}", filename);
    println!("   Data: {} bytes", test_data.len());
    println!("   Preview: \"{}\"", 
             String::from_utf8_lossy(&test_data[..std::cmp::min(50, test_data.len())]));

    // Upload (SDK handles: prepare_upload → encrypt locally → finalize_upload)
    let start = std::time::Instant::now();
    let upload_result = sdk.upload(group_id, test_data, filename).await?;
    let elapsed = start.elapsed();
    
    println!("\n✅ Upload successful! ({:.2}s)", elapsed.as_secs_f64());
    println!("   CID: {}", upload_result.cid);
    println!("   Transaction ID: {}", upload_result.trans_id);
    println!("   File Hash: {}", upload_result.file_hash);

    // Retrieve (SDK handles: prepare_retrieve → decrypt locally)
    println!("\n📥 Retrieving file from CID: {}", upload_result.cid);
    
    let start = std::time::Instant::now();
    let retrieve_result = sdk.retrieve(group_id, &upload_result.cid).await?;
    let elapsed = start.elapsed();
    
    println!("\n✅ Retrieve successful! ({:.2}s)", elapsed.as_secs_f64());
    println!("   Data: {} bytes", retrieve_result.data.len());
    println!("   IPFS Hash: {}", retrieve_result.ipfs_hash);
    println!("   Group: {}", retrieve_result.group_id);

    // Verify data integrity
    println!("\n🔍 Verifying data integrity...");
    if retrieve_result.data == test_data {
        println!("   ✅ Data matches! Client-side encryption/decryption successful.");
        println!("   Retrieved: \"{}\"", String::from_utf8_lossy(&retrieve_result.data));
    } else {
        println!("   ❌ Data mismatch!");
        println!("   Original length: {}", test_data.len());
        println!("   Retrieved length: {}", retrieve_result.data.len());
        return Err("Data integrity check failed".into());
    }

    // Verify hash
    let computed_hash = NovaSdk::compute_hash(&retrieve_result.data);
    println!("\n   Computed hash:  {}", computed_hash);
    println!("   Uploaded hash:  {}", upload_result.file_hash);
    if computed_hash == upload_result.file_hash {
        println!("   ✅ Hash verified!");
    } else {
        println!("   ⚠️  Hash mismatch");
    }

    // Show transaction history
    println!("\n📊 Transaction history for group '{}':", group_id);
    match sdk.get_transactions_for_group(group_id, None).await {
        Ok(txs) => {
            println!("   Found {} transaction(s)", txs.len());
            for (i, tx) in txs.iter().take(3).enumerate() {
                println!("   [{}] IPFS: {}... | Hash: {}...", 
                    i + 1, 
                    &tx.ipfs_hash[..20.min(tx.ipfs_hash.len())], 
                    &tx.file_hash[..16]
                );
            }
            if txs.len() > 3 {
                println!("   ... and {} more", txs.len() - 3);
            }
        }
        Err(e) => println!("   Could not fetch transactions: {}", e),
    }

    println!("\n🎉 SDK test complete!");
    println!("\n📋 Summary:");
    println!("   ✅ Authentication working");
    println!("   ✅ Client-side encryption (AES-256-GCM)");
    println!("   ✅ IPFS upload via MCP");
    println!("   ✅ NEAR transaction recording");
    println!("   ✅ Client-side decryption");
    println!("   ✅ Data integrity verified");
    println!("\nℹ️  Your file is now:");
    println!("   - Encrypted locally (key never sent with data)");
    println!("   - Stored on IPFS: {}", upload_result.cid);
    println!("   - Recorded on NEAR: {}", upload_result.trans_id);
    
    Ok(())
}
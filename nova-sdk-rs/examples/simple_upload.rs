// nova-sdk-rs v3 Example: Simple Upload & Retrieve
//
// Environment variables required:
//   TEST_NOVA_ACCOUNT_ID - Your NOVA-managed account (e.g., "alice-nova.nova-sdk-5.testnet")
//   TEST_SESSION_TOKEN   - JWT from nova-sdk.com/api/auth/session-token
//
// Run with: cargo run --example simple_upload

use nova_sdk_rs::NovaSdk;
use std::env;
use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Load from env
    let account_id = env::var("TEST_NOVA_ACCOUNT_ID")
        .expect("TEST_NOVA_ACCOUNT_ID required (e.g., alice-nova.nova-sdk-5.testnet)");
    let session_token = env::var("TEST_SESSION_TOKEN")
        .expect("TEST_SESSION_TOKEN required (get from nova-sdk.com/api/auth/session-token)");

    // Initialize SDK (v3: account_id + session_token only)
    // MCP server handles: signing, encryption, IPFS, Shade TEE
    let sdk = NovaSdk::new(&account_id, &session_token)?;
    
    println!("🔧 SDK initialized for account: {}", sdk.account_id());
    println!("   Contract: {}", sdk.contract_id());
    println!("   MCP: {}", sdk.mcp_url());

    let group_id = "demo_group";

    // Check auth status
    println!("\n🔍 Checking authentication...");
    match sdk.auth_status(Some(group_id)).await {
        Ok(status) => {
            println!("   ✅ Authenticated: {}", status.authenticated);
            println!("   Account: {:?}", status.near_account_id);
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
        Err(e) if e.to_string().contains("exists") || e.to_string().contains("already") => {
            println!("   ⚠️  Group already exists (OK)")
        }
        Err(e) => println!("   ❌ Registration failed: {} (continuing anyway)", e),
    }

    // Prepare test data
    let test_data = b"Hello from NOVA SDK v3! This is encrypted and stored on IPFS.";
    let filename = "hello.txt";
    
    println!("\n📤 Uploading file...");
    println!("   Filename: {}", filename);
    println!("   Data: {} bytes", test_data.len());
    println!("   Preview: \"{}\"", String::from_utf8_lossy(&test_data[..std::cmp::min(50, test_data.len())]));

    // Upload (MCP handles: get key → encrypt → IPFS upload → record transaction)
    let upload_result = sdk.composite_upload(group_id, test_data, filename).await?;
    
    println!("\n✅ Upload successful!");
    println!("   CID: {}", upload_result.cid);
    println!("   Transaction ID: {}", upload_result.trans_id);
    println!("   File Hash: {}", upload_result.file_hash);
    println!("   Fees:");
    println!("     - Claim: {:.6} NEAR", upload_result.fee_breakdown.claim);
    if let Some(record) = upload_result.fee_breakdown.record {
        println!("     - Record: {:.6} NEAR", record);
    }
    println!("     - Total: {:.6} NEAR", upload_result.fee_breakdown.total);

    // Retrieve (MCP handles: get key → IPFS fetch → decrypt)
    println!("\n📥 Retrieving file from CID: {}", upload_result.cid);
    
    let retrieve_result = sdk.composite_retrieve(group_id, &upload_result.cid).await?;
    
    println!("\n✅ Retrieve successful!");
    println!("   Data: {} bytes", retrieve_result.data.len());
    println!("   File Hash: {}", retrieve_result.file_hash);
    println!("   IPFS Hash: {}", retrieve_result.ipfs_hash);
    println!("   Group: {}", retrieve_result.group_id);
    println!("   Fees:");
    println!("     - Claim: {:.6} NEAR", retrieve_result.fee_breakdown.claim);
    println!("     - Total: {:.6} NEAR", retrieve_result.fee_breakdown.total);

    // Verify data integrity
    println!("\n🔍 Verifying data integrity...");
    if retrieve_result.data == test_data {
        println!("   ✅ Data matches! Decryption successful.");
        println!("   Retrieved: \"{}\"", String::from_utf8_lossy(&retrieve_result.data));
    } else {
        println!("   ❌ Data mismatch!");
        println!("   Original: {:?}", test_data);
        println!("   Retrieved: {:?}", retrieve_result.data);
        return Err("Data integrity check failed".into());
    }

    // Verify hash
    let computed_hash = NovaSdk::compute_hash(&retrieve_result.data);
    if computed_hash == retrieve_result.file_hash {
        println!("   ✅ Hash verified!");
    } else {
        println!("   ⚠️  Hash mismatch (computed vs returned)");
    }

    // Show transaction history
    println!("\n📊 Transaction history for group '{}':", group_id);
    match sdk.get_transactions_for_group(group_id, None).await {
        Ok(txs) => {
            println!("   Found {} transaction(s)", txs.len());
            for (i, tx) in txs.iter().take(3).enumerate() {
                println!("   [{}] IPFS: {} | Hash: {}...", 
                    i + 1, 
                    tx.ipfs_hash, 
                    &tx.file_hash[..16]
                );
            }
            if txs.len() > 3 {
                println!("   ... and {} more", txs.len() - 3);
            }
        }
        Err(e) => println!("   Could not fetch transactions: {}", e),
    }

    println!("\n🎉 Upload/retrieve demo complete!");
    println!("\nℹ️  Your file is now:");
    println!("   - Encrypted with group key (managed by Shade TEE)");
    println!("   - Stored on IPFS (CID: {})", upload_result.cid);
    println!("   - Recorded on NEAR blockchain (TX: {})", upload_result.trans_id);
    
    Ok(())
}
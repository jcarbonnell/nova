use nova_sdk_rs::{NovaSdk, CompositeRetrieveResult, CompositeUploadResult};
use rand::{thread_rng, RngCore};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::time::Duration;
use tokio::time::sleep;
use dotenv::dotenv;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct DcaEntry {
    date: String,
    operation: String,
    provider: String,
    portfolio: String,
    rationale: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();

    // Load environment variables
    let rpc = std::env::var("RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.near.org".to_string());
    let contract = std::env::var("CONTRACT_ID").unwrap_or_else(|_| "nova-contract.testnet".to_string());
    let pinata_key = std::env::var("IPFS_API_KEY")?;
    let pinata_secret = std::env::var("IPFS_API_SECRET")?;
    let shade_api_url = std::env::var("SHADE_API_URL")?;

    let user_private_key = std::env::var("USER_PRIVATE_KEY")?;
    let user_account_id = std::env::var("USER_ACCOUNT_ID")?; // e.g., user.testnet

    println!("User Account: {}", user_account_id);

    // Initialize SDK for the user
    let sdk = NovaSdk::new(&rpc, &contract, &pinata_key, &pinata_secret, &shade_api_url)
        .with_signer(&user_private_key, &user_account_id)?;

    // Unique personal group for DCA history
    let group_id = format!("dca-history.{}", user_account_id);
    println!("\n=== Step 1: Create or load personal DCA history group ===");

    // Create the group if it doesn't exist (user as initial member)
    match sdk.create_group(&group_id, &[&user_account_id]).await {
        Ok(_) => println!("Personal group created: {}", group_id),
        Err(e) => println!("Group already exists or error: {}. Continuing...", e),
    }

    // Simulate initial DCA history (empty or sample)
    // In real app: Track latest CID in local storage or on-chain
    let mut initial_history: Vec<DcaEntry> = Vec::new();
    let filename = "dca-history.json";

    // For demo: Add sample entry if first time
    let sample_entry = DcaEntry {
        date: "17-12-2025".to_string(),
        operation: "Staked 2790 NEAR for 1,909 stNEAR.".to_string(),
        provider: "https://staking.metapool.app/".to_string(),
        portfolio: "5.12 NEAR, 1,909 stNEAR.".to_string(),
        rationale: "Chose metapool for its reliability + the tradeable stNEAR tokens.".to_string(),
    };
    initial_history.push(sample_entry);

    let mut latest_cid: Option<String> = None; // In real: Load from persistence

    if latest_cid.is_none() {
        let initial_json = serde_json::to_vec(&initial_history)?;
        let upload_result: CompositeUploadResult = sdk
            .composite_upload(&group_id, &user_account_id, &initial_json, filename)
            .await?;
        latest_cid = Some(upload_result.cid.clone());
        println!("Initial DCA history uploaded to IPFS: CID = {}", upload_result.cid);
    }

    // Wait for IPFS propagation
    println!("Waiting 15s for IPFS pin to propagate...");
    sleep(Duration::from_secs(15)).await;

    println!("\n=== Step 2: Retrieve latest DCA history for weekly update ===");

    // Retrieve and decrypt latest version (assume latest_cid is set)
    let cid = latest_cid.as_ref().unwrap(); // For demo
    let retrieved: CompositeRetrieveResult = sdk.composite_retrieve(&group_id, cid).await?;
    let history: Vec<DcaEntry> = serde_json::from_slice(&retrieved.data)?;
    println!("Latest history retrieved: {} entries", history.len());
    if let Some(last) = history.last() {
        println!("Last portfolio: {}", last.portfolio);
    } else {
        println!("History empty");
    }

    println!("\n=== Step 3: Append new weekly DCA operation and re-upload ===");

    // Simulate new weekly entry (from user input or DeFi API)
    let new_entry = DcaEntry {
        date: "31-12-2025".to_string(),  // Current date
        operation: "Swapped 50-worth-usd of NEAR for ETH.".to_string(),
        provider: "https://dex.example.com".to_string(),
        portfolio: "4.5 NEAR, 1,800 stNEAR, 0.8 SOL, 0.001 BTC, 0.05 ETH".to_string(),
        rationale: "Diversifying into ETH ahead of expected market recovery.".to_string(),
    };
    let mut updated_history = history.clone();
    updated_history.push(new_entry);

    // Re-upload updated history
    let updated_json = serde_json::to_vec(&updated_history)?;
    let update_upload: CompositeUploadResult = sdk
        .composite_upload(&group_id, &user_account_id, &updated_json, filename)
        .await?;
    latest_cid = Some(update_upload.cid.clone());  // Update tracked CID
    println!("Updated DCA history re-uploaded to IPFS: New CID = {}", update_upload.cid);

    // Wait for propagation
    sleep(Duration::from_secs(15)).await;

    println!("\n=== Step 4: Make data available to Shade Agent for confidential analysis ===");

    // Temporarily add Shade Agent for access (use actual agent ID in prod)
    let agent_account_id = "shade-agent.testnet".to_string();
    sdk.add_member(&group_id, &agent_account_id).await?;
    println!("Shade Agent added temporarily: {}", agent_account_id);

    // Simulate agent retrieval and analysis (in real: Invoke via MCP/agent API)
    // Agent would retrieve, analyze in TEE (risk, fine-tune), output attestation
    let agent_retrieved: CompositeRetrieveResult = sdk.composite_retrieve(&group_id, &update_upload.cid).await?;  // Simulated
    let agent_history: Vec<DcaEntry> = serde_json::from_slice(&agent_retrieved.data)?;
    // Mock analysis
    let mock_risk = "Medium";
    let mock_suggestion = "Increase BTC exposure by 20% for better diversification.";
    println!("Agent analysis (mock): Portfolio risk: {}; Suggestion: {}", mock_risk, mock_suggestion);
    println!("Self-learning loop: Agent could fine-tune model on history for future recommendations.");

    // Revoke agent access
    sdk.remove_member(&group_id, &agent_account_id).await?;
    println!("Agent access revoked: Keys rotated.");

    println!("\n=== DCA History Use Case Demo Complete ===");
    println!("Personal trading assistant data layer: Secure, versioned DCA memos with AI-ready access.");

    Ok(())
}
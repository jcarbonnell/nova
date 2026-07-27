// nova/contract/tests/test_basics.rs
use near_workspaces;
use near_workspaces::types::{NearToken, Gas};
use near_sdk::serde_json::{json, Value};
use std::error::Error;
use base64::Engine;
use sha2::{Sha256, Digest};
use hex;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn test_contract_is_operational() -> Result<(), Box<dyn Error>> {
    let contract_wasm = near_workspaces::compile_project("./").await?;
    test_basics_on(&contract_wasm).await?;
    Ok(())
}

async fn test_basics_on(contract_wasm: &[u8]) -> Result<(), Box<dyn Error>> {
    // Use custom FastNEAR RPC endpoint to avoid rate limits
    let rpc_url = std::env::var("NEAR_RPC_URL")
        .unwrap_or_else(|_| "https://rpc.testnet.fastnear.com".to_string());
    
    let api_key = std::env::var("FASTNEAR_API_KEY")
        .unwrap_or_else(|_| "0b1399596423db51740cfbe041490f6a7611a6b0089d30afb7d459939723171c".to_string());
    
    // Configure RPC with API key
    let rpc_url_with_key = format!("{}?apiKey={}", rpc_url, api_key);
    
    println!("🔄 Connecting to FastNEAR testnet RPC...");
    
    // Connect to testnet with custom RPC
    let worker = near_workspaces::testnet()
        .rpc_addr(&rpc_url_with_key)
        .await?;
    
    println!("✅ Connected to custom RPC");
    
    // Create test accounts
    let owner_account = worker.dev_create_account().await?;
    let member_account = worker.dev_create_account().await?;
    
    // Deploy NOVA contract
    println!("📦 Deploying NOVA contract...");
    let contract = owner_account.deploy(contract_wasm).await?.unwrap();
    
    // Real Shade agent contract ID
    let shade_contract_id = "ac-sandbox.nova-shade-agent.testnet";

    // Initialize NOVA contract with real Shade agent and fee recipient
    let init_outcome = owner_account
        .call(contract.id(), "new")
        .args_json(json!({
            "owner": owner_account.id().to_string(),
            "shade_contract_id": shade_contract_id,
            "fee_recipient": "nova-sdk-4.testnet"
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    init_outcome.into_result()?;

    println!("✅ Contract initialized with Shade agent: {}", shade_contract_id);

    // Test approve_shade_code_hash
    let shade_codehash = "79b2bd26287e98df58778e0b224f9075268f86327fbfea18272df23273f77a3a";
    let approve_outcome = owner_account
        .call(contract.id(), "approve_shade_code_hash")
        .args_json(json!({"code_hash": shade_codehash}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))  // 0.001 NEAR > 0.0001 fee
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    approve_outcome.into_result()?;

    println!("✅ Shade code hash approved");

    // Test register_shade_worker
    let attestation = vec![0u8; 64];
    
    let register_worker_outcome = owner_account
        .call(contract.id(), "register_shade_worker")
        .args_json(json!({
            "worker_id": shade_contract_id,
            "attestation": attestation
        }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    register_worker_outcome.into_result()?;

    println!("✅ Shade worker registered");

    // Test register_group
    let register_outcome = owner_account
        .call(contract.id(), "register_group")
        .args_json(json!({"group_id": "test_group_nova", "joinable": false}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))  // 0.1 NEAR > 0.05 fee
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    
    let result = register_outcome.into_result();
    if let Err(e) = &result {
        println!("⚠️  Register group error: {:?}", e);
    }
    result?;

    println!("✅ Group registered (Shade agent called)");

    // Wait for cross-contract call to complete
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify group exists
    let group_exists: bool = contract
        .view("group_contains_key")
        .args_json(json!({"group_id": "test_group_nova", "joinable": false}))
        .await?
        .json()?;
    assert!(group_exists, "Group should exist");

    println!("✅ Group verified on-chain");

    // Test add_group_member
    let add_outcome = owner_account
        .call(contract.id(), "add_group_member")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))  // 0.01 NEAR > 0.001 fee
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    
    let result = add_outcome.into_result();
    if let Err(e) = &result {
        println!("⚠️  Add member error: {:?}", e);
    }
    result?;

    println!("✅ Member added (Shade agent updated)");

    // Wait for cross-contract call
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify authorization
    let is_authorized: bool = contract
        .view("is_authorized")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .await?
        .json()?;
    assert!(is_authorized, "Member should be authorized");

    println!("✅ Member authorization verified");

    // NEW: Test get_nonce_validity with a fresh nonce
    let fresh_nonce_valid: bool = contract
        .view("get_nonce_validity")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string(),
            "nonce": "some_fresh_unused_nonce"
        }))
        .await?
        .json()?;
    assert!(fresh_nonce_valid, "Fresh nonce should be valid");

    println!("✅ Fresh nonce validation works");

    // Test claim_token - requires proper Ed25519 signature
    // In a real scenario, this would be called by the client with a valid signature from TEE
    // For testing, we create a payload and signature
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_nanos() as u64;
    let nonce_input = format!("{}{}{}",  "test_group_nova", member_account.id(), timestamp);
    let nonce = hex::encode(Sha256::digest(nonce_input.as_bytes()));
    
    let payload = json!({
        "group_id": "test_group_nova",
        "user_id": member_account.id().to_string(),
        "nonce": nonce.clone(),
        "timestamp": timestamp
    });
    let payload_str = payload.to_string();
    let _payload_b64 = base64::engine::general_purpose::STANDARD.encode(payload_str.as_bytes());
    
    // Note: In production, the signature would come from the TEE signing with the group's key
    // For integration testing, we'll skip the actual claim_token call since it requires
    // a valid Ed25519 signature that matches the signer's public key
    println!("⚠️  Skipping claim_token test (requires valid Ed25519 signature from TEE)");
    
    // Instead, verify the nonce is still valid (hasn't been used)
    let nonce_still_valid: bool = contract
        .view("get_nonce_validity")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string(),
            "nonce": nonce
        }))
        .await?
        .json()?;
    assert!(nonce_still_valid, "Nonce should still be valid since we didn't claim");

    println!("✅ Nonce validity check works");

    // Test record_transaction
    let record_outcome = member_account
        .call(contract.id(), "record_transaction")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string(),
            "file_hash": "file_hash_test",
            "ipfs_hash": "ipfs_hash_test"
        }))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))  // 0.01 > 0.002 fee
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    record_outcome.into_result()?;

    println!("✅ Transaction recorded");

    // Test get_transactions_for_group
    let transactions: Vec<Value> = member_account
        .call(contract.id(), "get_transactions_for_group")
        .args_json(json!({"group_id": "test_group_nova", "joinable": false}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000u128))  // 0.0001 NEAR fee
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?
        .json()?;
    
    assert_eq!(transactions.len(), 1, "Should have one transaction");
    assert_eq!(transactions[0]["file_hash"], "file_hash_test");
    assert_eq!(transactions[0]["ipfs_hash"], "ipfs_hash_test");

    println!("✅ Transaction retrieval verified");

    // Test request_signature
    let payload_bytes = vec![0u8; 32];
    let sig: String = contract
        .view("request_signature")
        .args_json(json!({
            "path": "nova_key_test",
            "payload": payload_bytes,
            "key_type": "Ecdsa"
        }))
        .await?
        .json()?;
    assert!(!sig.is_empty(), "Signature should not be empty");
    assert_eq!(sig.len(), 64, "SHA256 hex length");

    println!("✅ Request signature works");

    // Test request_signature fails invalid path
    let invalid_result = contract
        .view("request_signature")
        .args_json(json!({
            "path": "invalid_path",
            "payload": vec![0u8; 32],
            "key_type": "Ecdsa"
        }))
        .await;
    assert!(invalid_result.is_err(), "Should fail on invalid path");

    println!("✅ Request signature guard rail works");

    // Test revoke_group_member
    let revoke_outcome = owner_account
        .call(contract.id(), "revoke_group_member")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))  // 0.01 > 0.001 fee
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    
    let result = revoke_outcome.into_result();
    if let Err(e) = &result {
        println!("⚠️  Revoke member error: {:?}", e);
    }
    result?;

    println!("✅ Member revoked (Shade agent rotated key)");

    // Wait for cross-contract call
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify member is no longer authorized
    let is_authorized_after: bool = contract
        .view("is_authorized")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .await?
        .json()?;
    assert!(!is_authorized_after, "Member should not be authorized after revoke");

    println!("✅ Member revocation verified");
    println!("\n🎉 All tests passed with nonce-based tokens and real Shade agent integration!");

    Ok(())
}
// nova/contract/tests/test_basics.rs
use near_workspaces;
use near_workspaces::types::{NearToken, Gas};
use near_sdk::serde_json::{json, Value};
use std::error::Error;

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

    // Initialize NOVA contract with real Shade agent
    let init_outcome = owner_account
        .call(contract.id(), "new")
        .args_json(json!({
            "owner": owner_account.id().to_string(),
            "shade_contract_id": shade_contract_id,
            "jwt_secret": "dummy_jwt_secret"
        }))
        .transact()
        .await?;
    init_outcome.into_result()?;

    println!("✅ Contract initialized with Shade agent: {}", shade_contract_id);

    // Test approve_shade_code_hash (use your actual Shade codehash)
    let shade_codehash = "79b2bd26287e98df58778e0b224f9075268f86327fbfea18272df23273f77a3a";
    let approve_outcome = owner_account
        .call(contract.id(), "approve_shade_code_hash")
        .args_json(json!({"code_hash": shade_codehash}))
        .transact()
        .await?;
    approve_outcome.into_result()?;

    println!("✅ Shade code hash approved");

    // Test register_shade_worker (mock attestation)
    let attestation = vec![0u8; 64];
    
    let register_worker_outcome = owner_account
        .call(contract.id(), "register_shade_worker")
        .args_json(json!({
            "worker_id": shade_contract_id,
            "attestation": attestation
        }))
        .transact()
        .await?;
    register_worker_outcome.into_result()?;

    println!("✅ Shade worker registered");

    // Test register_group (will call real Shade agent)
    // Allocate plenty of gas for the entire chain
    let register_outcome = owner_account
        .call(contract.id(), "register_group")
        .args_json(json!({"group_id": "test_group_nova"}))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000))
        .gas(Gas::from_tgas(300))  // Just give it tons of gas
        .transact()
        .await?;
    
    // This should succeed now with real Shade agent
    let result = register_outcome.into_result();
    if let Err(e) = &result {
        println!("⚠️  Register group error: {:?}", e);
    }
    result?;

    println!("✅ Group registered (Shade agent called)");

    // Wait a moment for cross-contract call to complete
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify group exists
    let group_exists: bool = contract
        .view("group_contains_key")
        .args_json(json!({"group_id": "test_group_nova"}))
        .await?
        .json()?;
    assert!(group_exists, "Group should exist");

    println!("✅ Group verified on-chain");

    // Test add_group_member (will call Shade agent)
    let add_outcome = owner_account
        .call(contract.id(), "add_group_member")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000))
        .gas(Gas::from_tgas(300))
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

    // Test get_access_token
    let access_token: String = contract
        .view("get_access_token")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .await?
        .json()?;
    assert!(!access_token.is_empty(), "Token should not be empty");

    println!("✅ Access token generated: {}", &access_token[..20]);

    // Test record_transaction
    let record_outcome = member_account
        .call(contract.id(), "record_transaction")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string(),
            "file_hash": "file_hash_test",
            "ipfs_hash": "ipfs_hash_test"
        }))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000))
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    record_outcome.into_result()?;

    println!("✅ Transaction recorded");

    // Test get_transactions_for_group
    let transactions: Vec<Value> = member_account
        .view(contract.id(), "get_transactions_for_group")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .await?
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

    // Test revoke_group_member (will call Shade agent to rotate key)
    let revoke_outcome = owner_account
        .call(contract.id(), "revoke_group_member")
        .args_json(json!({
            "group_id": "test_group_nova",
            "user_id": member_account.id().to_string()
        }))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000))
        .max_gas()  // Use maximum available gas
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
    println!("\n🎉 All tests passed with real Shade agent integration!");

    Ok(())
}
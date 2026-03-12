use near_workspaces::{types::NearToken, Account};
use serde_json::json;
use anyhow::Result;

#[tokio::test]
async fn test_kv_contract_basics() -> Result<()> {
    let sandbox = near_workspaces::sandbox().await?;
    let contract_wasm = near_workspaces::compile_project("./").await?;

    let contract = sandbox.dev_deploy(&contract_wasm).await?;

    // Create owner account (random dev account with funds)
    let owner: Account = sandbox.dev_create_account().await?;

    // Create test user account (another random dev account)
    let user: Account = sandbox.dev_create_account().await?;

    // Test 1: Add allowed code hash (only owner)
    let outcome = owner
        .call(contract.id(), "add_code_hash")
        .args_json(json!({"code_hash": "deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678".to_string()}))
        .transact()
        .await?;
    assert!(outcome.is_success(), "add_code_hash failed: {:?}", outcome.failures());

    // Test 2: Store a blob as owner
    let blob: Vec<u8> = vec![42; 16]; // sample encrypted data
    let outcome = owner
        .call(contract.id(), "store")
        .args_json(json!({"key": "test-key-1".to_string(), "encrypted_blob": blob.clone()}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?;
    assert!(outcome.is_success(), "store failed: {:?}", outcome.failures());

    // Test 3: Retrieve the blob
    let view_result = contract
        .view("get")
        .args_json(json!({"key": "test-key-1".to_string()}))
        .await?;
    let retrieved: Option<Vec<u8>> = view_result.json()?;
    assert_eq!(retrieved, Some(blob), "Blob mismatch on retrieve");

    // Test 4: Unauthorized store should fail
    let outcome = user
        .call(contract.id(), "store")
        .args_json(json!({"key": "evil-key".to_string(), "encrypted_blob": vec![99, 99, 99]}))
        .deposit(NearToken::from_millinear(100))
        .transact()
        .await?;
    assert!(!outcome.is_success(), "Unauthorized store should have failed: {:?}", outcome.failures());

    // Test 5: Migration (should succeed as owner)
    let outcome = owner
        .call(contract.id(), "migrate")
        .transact()
        .await?;
    assert!(outcome.is_success(), "migrate failed: {:?}", outcome.failures());

    // Verify version bumped
    let version_result = contract
        .view("get_version")
        .args_json(json!({}))
        .await?
        .json::<u32>()?;
    assert_eq!(version_result, 2, "Version should be 2 after migration");

    Ok(())
}
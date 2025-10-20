// nova-sdk/contract/tests/test_basics.rs
use near_workspaces;
use serde_json::json;
use near_sdk::base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use near_sdk::Gas;
use near_sdk::NearToken;
use std::fs;  // For loading pre-built WASM
use near_primitives::types::AccountId;  // Explicit for parse

#[tokio::test]
async fn test_contract_is_operational() -> Result<(), Box<dyn std::error::Error>> {
    // Pre-build: Run `cargo near build --release` once; load wasm to skip in-test build
    let wasm_path = "target/near/nova.wasm";  // Output from cargo near build
    let contract_wasm = fs::read(wasm_path).expect("Run `cargo near build --release` first to generate wasm");
    
    test_basics_on(&contract_wasm).await?;
    Ok(())
}

async fn test_basics_on(contract_wasm: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
    let sandbox = near_workspaces::sandbox().await?;
    let contract = sandbox.dev_deploy(contract_wasm).await?;
    let owner_account = sandbox.dev_create_account().await?;
    let member_account = sandbox.dev_create_account().await?;
    let shade_contract_id: AccountId = AccountId::try_from("shade.testnet".to_string()).unwrap();  // Explicit type
    let jwt_secret = "dummy_jwt_secret".to_string();

    // Initialize (shade_contract_id, jwt_secret)
    let init_outcome = owner_account
        .call(&contract.id(), "new")
        .args_json(json!({
            "owner": owner_account.id(),
            "shade_contract_id": shade_contract_id.to_string(),
            "jwt_secret": jwt_secret
        }))
        .gas(Gas::from_tgas(300))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000u128))  // 0.1 NEAR (u128 literal)
        .transact()
        .await?;
    assert!(init_outcome.is_success());

    // register_group (triggers promise; assert success)
    let register_outcome = owner_account
        .call(&contract.id(), "register_group")
        .args_json(json!({"group_id": "test_group"}))
        .gas(Gas::from_tgas(500))  // For promise
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000u128))  // 0.1 NEAR
        .transact()
        .await?;
    assert!(register_outcome.is_success());

    // group_contains_key
    let group_exists: bool = contract.view("group_contains_key").args_json(json!({"group_id": "test_group"})).await?.json()?;
    assert!(group_exists);

    // approve_shade_code_hash
    let code_hash = "dummy_hash".to_string();
    let approve_outcome = owner_account
        .call(&contract.id(), "approve_shade_code_hash")
        .args_json(json!({"code_hash": code_hash}))
        .gas(Gas::from_tgas(200))
        .deposit(NearToken::from_yoctonear(500_000_000_000_000_000u128))  // 0.0005 NEAR (u128)
        .transact()
        .await?;
    assert!(approve_outcome.is_success());

    // register_shade_worker (dummy attestation base64)
    let worker_id = "worker.testnet".to_string();
    let dummy_attestation = vec![0u8; 64];
    let att_b64 = BASE64_STANDARD.encode(&dummy_attestation);
    let register_worker_outcome = owner_account
        .call(&contract.id(), "register_shade_worker")
        .args_json(json!({
            "worker_id": worker_id,
            "attestation": att_b64
        }))
        .gas(Gas::from_tgas(200))
        .deposit(NearToken::from_yoctonear(500_000_000_000_000_000u128))  // 0.0005 NEAR
        .transact()
        .await?;
    assert!(register_worker_outcome.is_success());

    // add_group_member (promise to Shade)
    let add_outcome = owner_account
        .call(&contract.id(), "add_group_member")
        .args_json(json!({"group_id": "test_group", "user_id": member_account.id()}))
        .gas(Gas::from_tgas(500))
        .deposit(NearToken::from_yoctonear(500_000_000_000_000_000u128))  // 0.0005 NEAR
        .transact()
        .await?;
    assert!(add_outcome.is_success());

    // is_authorized
    let is_authorized: bool = contract.view("is_authorized").args_json(json!({"group_id": "test_group", "user_id": member_account.id()})).await?.json()?;
    assert!(is_authorized);

    // get_access_token
    let token: String = contract.view("get_access_token").args_json(json!({"group_id": "test_group", "user_id": member_account.id()})).await?.json()?;
    assert!(!token.is_empty());
    assert!(token.contains("."));  // payload.sig format

    // revoke_group_member (promise to rotate)
    let revoke_outcome = owner_account
        .call(&contract.id(), "revoke_group_member")
        .args_json(json!({"group_id": "test_group", "user_id": member_account.id()}))
        .gas(Gas::from_tgas(500))
        .deposit(NearToken::from_yoctonear(500_000_000_000_000_000u128))  // 0.0005 NEAR
        .transact()
        .await?;
    assert!(revoke_outcome.is_success());

    // is_authorized after revoke
    let is_authorized: bool = contract.view("is_authorized").args_json(json!({"group_id": "test_group", "user_id": member_account.id()})).await?.json()?;
    assert!(!is_authorized);

    // record_transaction (owner as uploader)
    let record_outcome = owner_account
        .call(&contract.id(), "record_transaction")
        .args_json(json!({
            "group_id": "test_group",
            "user_id": owner_account.id(),
            "file_hash": "file_hash",
            "ipfs_hash": "ipfs_hash"
        }))
        .gas(Gas::from_tgas(300))
        .deposit(NearToken::from_yoctonear(2_000_000_000_000_000_000u128))  // 0.002 NEAR
        .transact()
        .await?;
    assert!(record_outcome.is_success());

    // get_transactions_for_group
    let transactions: Vec<serde_json::Value> = owner_account.view(&contract.id(), "get_transactions_for_group").args_json(json!({"group_id": "test_group", "user_id": owner_account.id()})).await?.json()?;
    assert_eq!(transactions.len(), 1);
    // Fixed: Compare strings
    assert_eq!(transactions[0]["user_id"].as_str().unwrap(), owner_account.id().as_str());
    assert_eq!(transactions[0]["file_hash"].as_str().unwrap(), "file_hash");

    Ok(())
}
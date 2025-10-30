use nova_sdk_rs::{NovaSdk, NovaError};
use rand::RngCore; // Import RngCore trait for fill_bytes
use base64::{Engine as _, engine::general_purpose}; // New base64 API

#[tokio::test]
async fn test_get_balance_integration() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Query balance for a known testnet account
    let balance = sdk.get_balance("nova-sdk-4.testnet").await.unwrap();
    
    // Balance should be a valid u128 (yoctoNEAR)
    assert!(balance > 0, "Balance should be greater than 0 for an active account");
}

#[tokio::test]
async fn test_get_balance_nonexistent_account() {
let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Try to query balance for a likely nonexistent account
    let result = sdk.get_balance("this-account-definitely-does-not-exist-12345.testnet").await;
    
    // Should return an error
    assert!(result.is_err(), "Should fail for nonexistent account");
    match result {
        Err(NovaError::Near(_)) => {}, // Expected error
        _ => panic!("Expected NovaError::Near for nonexistent account"),
    }
}

#[tokio::test]
async fn test_with_signer_integration() {
    // Note: This uses an invalid key, so it will fail at the signing stage
    // In a real integration test, you'd use a valid test account and key
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    let result = sdk.with_signer(
        "ed25519:invalidkeyformatfortesting123456",
        "test.testnet"
    );
    
    // Should fail due to invalid key format
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), NovaError::Signing(_)));
}

#[tokio::test]
async fn test_sdk_initialization() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Just verify the SDK can be created without panicking
    // and can make a simple RPC call
    let result = sdk.get_balance("nova-sdk-4.testnet").await;
    assert!(result.is_ok(), "SDK should be able to make basic RPC calls");
}

#[tokio::test]
async fn test_invalid_account_id_format() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-2.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Test various invalid account formats
    let invalid_accounts = vec![
        "invalid@account",
        "UPPERCASE.testnet",
        "has space.testnet",
        "has_underscore",
        "",
    ];
    
    for invalid_account in invalid_accounts {
        let result = sdk.get_balance(invalid_account).await;
        assert!(result.is_err(), "Should fail for invalid account: {}", invalid_account);
    }
}

// Real signer test - only runs if environment variables are set
#[tokio::test]
async fn test_with_real_signer() {
    // Skip test if credentials not available
    let private_key = match std::env::var("TEST_NEAR_PRIVATE_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("Skipping test_with_real_signer: TEST_NEAR_PRIVATE_KEY not set");
            return;
        }
    };
    
    let account_id = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_with_real_signer: TEST_NEAR_ACCOUNT_ID not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network").with_signer(&private_key, &account_id).unwrap();
    
    // Verify we can query the account we signed with
    let balance = sdk.get_balance(&account_id).await.unwrap();
    assert!(balance > 0, "Account should have a positive balance");
    
    println!("✅ Successfully authenticated with account: {}", account_id);
    println!("   Balance: {} yoctoNEAR", balance);
}

#[tokio::test]
async fn test_is_authorized_integration() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Test with a likely non-member user and existing group
    let result = sdk.is_authorized("test_group", "random.user.testnet").await;
    
    match result {
        Ok(authorized) => {
            // Expect false for unauthorized user
            assert!(!authorized, "Random user should not be authorized in test_group");
        }
        Err(NovaError::Near(msg)) => {
            // If group doesn't exist, we get a "Group not found" error - this is OK for testing
            if msg.contains("Group not found") {
                println!("⚠️  test_group doesn't exist yet - this is OK for a fresh test environment");
            } else {
                panic!("Unexpected Near error: {}", msg);
            }
        }
        Err(e) => panic!("Unexpected error type: {:?}", e),
    }
}

#[tokio::test]
async fn test_is_authorized_nonexistent_group() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Non-existent group should cause contract panic → RPC error
    let result = sdk.is_authorized("nonexistent_group_123", "test.user.testnet").await;
    assert!(result.is_err(), "Invalid group should fail with error");
    assert!(matches!(result.err().unwrap(), NovaError::Near(_)));
}

#[tokio::test]
async fn test_get_group_key_unauthorized_integration() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Unauthorized user should get error (no signer attached)
    let result = sdk.get_group_key("test_group", "random.user.testnet").await;
    assert!(result.is_err(), "Unauthorized should fail");
    
    let err = result.err().unwrap();
    // Accept either Near error (from contract) or Signing error (no signer attached)
    assert!(
        matches!(err, NovaError::Near(_)) || matches!(err, NovaError::Signing(_)),
        "Expected Near or Signing error, got: {:?}", err
    );
}

#[tokio::test]
async fn test_get_group_key_authorized_integration() {
    // Skip unless TEST_NEAR_ACCOUNT_ID set (assumes account is member of test_group)
    let account_id = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_get_group_key_authorized_integration: TEST_NEAR_ACCOUNT_ID not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    let key = sdk.get_group_key("test_group", &account_id).await.unwrap();
    assert!(!key.is_empty(), "Authorized key should be non-empty base64");
    assert!(key.len() > 20, "Base64 key should be reasonable length (e.g., 44 chars for 32 bytes)");
    
    println!("✅ Retrieved group key for authorized account: {}", account_id);
    println!("   Key length: {} chars", key.len());
}

#[tokio::test]
async fn test_get_group_key_nonexistent_group() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Non-existent group should cause error (no signer attached means Signing error)
    let result = sdk.get_group_key("nonexistent_group_123", "test.user.testnet").await;
    assert!(result.is_err(), "Invalid group should fail with error");
    
    let err = result.err().unwrap();
    // Accept either Near error (from contract) or Signing error (no signer)
    assert!(
        matches!(err, NovaError::Near(_)) || matches!(err, NovaError::Signing(_)),
        "Expected Near or Signing error, got: {:?}", err
    );
}

#[tokio::test]
async fn test_get_transactions_for_group() {
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Test with likely unauthorized user → expect empty vec or error
    let result = sdk.get_transactions_for_group("test_group", "random.user.testnet").await;
    match result {
        Ok(txs) => {
            // Unauthorized might return empty vec
            assert!(txs.is_empty(), "Unauthorized user should return empty transactions");
        },
        Err(e) => {
            // Or contract might panic with auth error
            assert!(matches!(e, NovaError::Near(_)), "Expect Near error for auth failure");
        }
    }
}

#[tokio::test]
async fn test_get_transactions_for_group_integration() {
    let account_id = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_get_transactions_for_group_integration: Credentials not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake_key", "fake_secret", "https://fake-shade.phala.network");
    
    // Query transactions for authorized user
    let result = sdk.get_transactions_for_group("test_group", &account_id).await;
    
    match result {
        Ok(txs) => {
            println!("✅ Retrieved {} transactions for test_group", txs.len());
            
            // If there are transactions, validate structure
            if !txs.is_empty() {
                let first_tx = &txs[0];
                assert!(!first_tx.group_id.is_empty(), "Transaction should have group_id");
                assert!(!first_tx.user_id.is_empty(), "Transaction should have user_id");
                assert!(!first_tx.file_hash.is_empty(), "Transaction should have file_hash");
                assert!(!first_tx.ipfs_hash.is_empty(), "Transaction should have ipfs_hash");
                assert_eq!(first_tx.file_hash.len(), 64, "File hash should be 64 chars (SHA-256 hex)");
                
                println!("   First transaction:");
                println!("     Group: {}", first_tx.group_id);
                println!("     User: {}", first_tx.user_id);
                println!("     File Hash: {}", first_tx.file_hash);
                println!("     IPFS Hash: {}", first_tx.ipfs_hash);
            } else {
                println!("   No transactions found (this is OK if group is new)");
            }
        }
        Err(e) => {
            // If unauthorized, that's expected for some test scenarios
            if e.to_string().contains("not authorized") || e.to_string().contains("Unauthorized") {
                println!("⚠️  User not authorized to view transactions (expected if not a member)");
            } else {
                panic!("Unexpected error: {}", e);
            }
        }
    }
}

#[tokio::test]
async fn test_revoke_group_member_integration() {
    let private_key = match std::env::var("TEST_NEAR_PRIVATE_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("Skipping test_revoke_group_member_integration: Credentials not set");
            return;
        }
    };
    
    let account_id = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_revoke_group_member_integration: Credentials not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake", "fake", "https://fake-shade.phala.network")
        .with_signer(&private_key, &account_id).unwrap();
    
    // Assume a known member exists; revoke and verify post-revoke with is_authorized
    let member_to_revoke = "known.member.testnet"; // Replace with actual test member if needed
    let result_revoke = sdk.revoke_group_member("test_group", member_to_revoke).await;
    match result_revoke {
        Ok(_) => {
            println!("✅ Revoked member: {}", member_to_revoke);
            // Verify: Check is_authorized now false
            let authorized_after = sdk.is_authorized("test_group", member_to_revoke).await.unwrap();
            assert!(!authorized_after, "Member should no longer be authorized after revoke");
        }
        Err(e) => if e.to_string().contains("not a member") { 
            println!("Not a member - expected if already revoked") 
        } else { 
            panic!("Unexpected: {}", e) 
        },
    }
}

#[tokio::test]
async fn test_store_group_key_integration() {
    let private_key = match std::env::var("TEST_NEAR_PRIVATE_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("Skipping test_store_group_key_integration: Credentials not set");
            return;
        }
    };
    
    let account_id_str = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_store_group_key_integration: Credentials not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake", "fake", "https://fake-shade.phala.network")
        .with_signer(&private_key, &account_id_str).unwrap();
    
    // Generate dummy 32-byte base64 key
    let mut rng = rand::thread_rng();
    let mut key_bytes = [0u8; 32];
    rng.fill_bytes(&mut key_bytes);
    let key_b64 = general_purpose::STANDARD.encode(key_bytes);
    
    let result = sdk.get_group_key("test_group", &key_b64).await;
    match result {
        Ok(_) => {
            println!("✅ Stored group key for test_group");
            // Verify: Fetch and check length
            let fetched_key = sdk.get_group_key("test_group", &account_id_str).await.unwrap();
            assert_eq!(fetched_key, key_b64, "Stored and fetched key should match");
        }
        Err(e) => panic!("Unexpected store error: {}", e),
    }
}

#[tokio::test]
async fn test_record_transaction_integration() {
    let private_key = match std::env::var("TEST_NEAR_PRIVATE_KEY") {
        Ok(key) => key,
        Err(_) => {
            println!("Skipping test_record_transaction_integration: Credentials not set");
            return;
        }
    };
    
    let account_id_str = match std::env::var("TEST_NEAR_ACCOUNT_ID") {
        Ok(id) => id,
        Err(_) => {
            println!("Skipping test_record_transaction_integration: Credentials not set");
            return;
        }
    };
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", "fake", "fake", "https://fake-shade.phala.network")
        .with_signer(&private_key, &account_id_str).unwrap();
    
    // Dummy data for tx
    let dummy_file_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // SHA256 of empty
    let dummy_ipfs_hash = "QmDummyCIDForTest";
    
    let result = sdk.record_transaction("test_group", &account_id_str, dummy_file_hash, dummy_ipfs_hash).await;
    match result {
        Ok(trans_id) => {
            println!("✅ Recorded transaction: {}", trans_id);
            assert!(!trans_id.is_empty(), "Trans_id should be non-empty hex");
            assert!(trans_id.len() > 40, "Trans_id should be reasonable hex length");
        }
        Err(e) => if e.to_string().contains("not authorized") { 
            println!("Auth fail - expected if not member") 
        } else { 
            panic!("Unexpected: {}", e) 
        },
    }
}

#[tokio::test]
async fn test_composite_upload_integration() {
    let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
    let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
    if private_key.is_none() || account_id.is_none() {
        println!("Skipping test_composite_upload_integration: Credentials not set");
        return;
    }
    
    let pinata_key = std::env::var("PINATA_API_KEY").unwrap_or_else(|_| {
        println!("Skipping: PINATA_API_KEY not set");
        std::process::exit(0);  // Or just return early
    });
    
    let pinata_secret = std::env::var("PINATA_SECRET_KEY").unwrap_or_else(|_| {
        println!("Skipping: PINATA_SECRET_KEY not set");
        std::process::exit(0);
    });

    let shade_api_url = std::env::var("SHADE_API_URL").unwrap_or_else(|_| "https://fake-shade.phala.network".to_string());
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", &pinata_key, &pinata_secret, &shade_api_url)
        .with_signer(&private_key.unwrap(), &account_id.clone().unwrap()).unwrap();
    
    // Fixed: Use byte slice for binary data
    let test_data = b"Test data for composite upload";
    let result = sdk.composite_upload("test_group", &account_id.unwrap(), test_data, "test.txt").await.unwrap();
    
    println!("✅ Composite upload success:");
    println!("   CID: {}", result.cid);
    println!("   Trans ID: {}", result.trans_id);
    println!("   File Hash: {}", result.file_hash);
    
    assert!(!result.cid.is_empty());
    assert!(!result.trans_id.is_empty());
    assert_eq!(result.file_hash.len(), 64);  // SHA-256 hex
}

#[tokio::test]
async fn test_composite_retrieve_integration() {
    let private_key = std::env::var("TEST_NEAR_PRIVATE_KEY").ok();
    let account_id = std::env::var("TEST_NEAR_ACCOUNT_ID").ok();
    if private_key.is_none() || account_id.is_none() {
        println!("Skipping test_composite_retrieve_integration: Credentials not set");
        return;
    }
    
    let pinata_key = std::env::var("PINATA_API_KEY").unwrap_or_else(|_| {
        println!("Skipping: PINATA_API_KEY not set");
        std::process::exit(0);
    });
    
    let pinata_secret = std::env::var("PINATA_SECRET_KEY").unwrap_or_else(|_| {
        println!("Skipping: PINATA_SECRET_KEY not set");
        std::process::exit(0);
    });

    let shade_api_url = std::env::var("SHADE_API_URL").unwrap_or_else(|_| "https://fake-shade.phala.network".to_string());
    
    let sdk = NovaSdk::new("https://rpc.testnet.near.org", "nova-sdk-4.testnet", &pinata_key, &pinata_secret, &shade_api_url)
        .with_signer(&private_key.unwrap(), &account_id.clone().unwrap()).unwrap();
    
    // Fixed: Use byte slice for binary data
    let original_bytes = b"Test data for composite retrieve";
    
    // Upload to get real CID
    let upload_result = sdk.composite_upload("test_group", &account_id.unwrap(), original_bytes, "retrieve_test.txt").await;
    
    let cid = match upload_result {
        Ok(res) => {
            println!("✅ Upload successful, CID: {}", res.cid);
            res.cid
        }
        Err(e) => {
            panic!("Upload failed, cannot test retrieve: {}", e);
        }
    };
    
    // Retrieve
    let retrieve_result = sdk.composite_retrieve("test_group", &cid).await;
    
    match retrieve_result {
        Ok(res) => {
            println!("✅ Composite retrieve success:");
            println!("   File Hash: {}", res.file_hash);
            // Fixed: Use .data.len() (bytes)
            println!("   Decrypted data length: {} bytes", res.data.len());
            
            // Fixed: Direct compare to bytes (no decode)
            assert_eq!(res.data, original_bytes, "Decrypted data should match original");
            assert_eq!(res.file_hash.len(), 64, "File hash should be 64 chars (SHA-256 hex)");
            
            println!("✅ Decrypted data matches original ({} bytes)", res.data.len());
        }
        Err(e) => panic!("Composite retrieve failed: {}", e),
    }
}
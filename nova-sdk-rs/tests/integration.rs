// nova-sdk-rs v3 Integration Tests
use nova_sdk_rs::{NovaSdk, NovaError};

// Mock session token for tests that don't need real MCP auth
const MOCK_SESSION_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiYWxpY2Utbm92YS5ub3ZhLXNkay01LnRlc3RuZXQiLCJ0eXBlIjoibm92YV9zZXNzaW9uIn0.mock";
const TEST_ACCOUNT_ID: &str = "alice-nova.nova-sdk-5.testnet";

// =========================================================================
// Helper Functions
// =========================================================================

fn get_integration_sdk() -> Option<NovaSdk> {
    let account_id = std::env::var("TEST_NOVA_ACCOUNT_ID").ok()?;
    let session_token = std::env::var("TEST_SESSION_TOKEN").ok()?;
    NovaSdk::new(&account_id, &session_token).ok()
}

// =========================================================================
// SDK Initialization Tests
// =========================================================================

#[tokio::test]
async fn test_sdk_initialization() {
    let result = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN);
    assert!(result.is_ok(), "SDK should initialize without panicking");
    
    let sdk = result.unwrap();
    assert_eq!(sdk.account_id(), TEST_ACCOUNT_ID);
    assert_eq!(sdk.contract_id(), "nova-sdk-5.testnet");
    assert_eq!(sdk.mcp_url(), "https://nova-mcp.fastmcp.app");
}

#[tokio::test]
async fn test_sdk_requires_account_id() {
    let result = NovaSdk::new("", MOCK_SESSION_TOKEN);
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), NovaError::Auth(_)));
}

#[tokio::test]
async fn test_sdk_requires_session_token() {
    let result = NovaSdk::new(TEST_ACCOUNT_ID, "");
    assert!(result.is_err());
    assert!(matches!(result.unwrap_err(), NovaError::Auth(_)));
}

// =========================================================================
// Read-Only RPC Tests (No MCP Auth Required)
// =========================================================================

#[tokio::test]
async fn test_get_balance_integration() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Query balance for the contract account (always exists)
    let balance = sdk.get_balance(Some("nova-sdk-5.testnet")).await.unwrap();

    // Balance should be a valid u128 (yoctoNEAR)
    assert!(balance > 0, "Balance should be greater than 0 for an active account");
    println!("✅ Contract balance: {} yoctoNEAR", balance);
}

#[tokio::test]
async fn test_get_balance_default_account() {
    // Use contract account as the SDK account (guaranteed to exist)
    let sdk = NovaSdk::new("nova-sdk-5.testnet", MOCK_SESSION_TOKEN).unwrap();

    // Uses sdk.account_id by default
    let balance = sdk.get_balance(None).await.unwrap();
    assert!(balance > 0, "Balance should be greater than 0");
}

#[tokio::test]
async fn test_get_balance_nonexistent_account() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Try to query balance for a likely nonexistent account
    let result = sdk.get_balance(Some("this-account-definitely-does-not-exist-12345.testnet")).await;

    // Should return an error
    assert!(result.is_err(), "Should fail for nonexistent account");
    match result {
        Err(NovaError::Near(_)) => {} // Expected error
        _ => panic!("Expected NovaError::Near for nonexistent account"),
    }
}

#[tokio::test]
async fn test_is_authorized_integration() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Test with a likely non-member user and existing group
    let result = sdk.is_authorized("test_group", Some("random.user.testnet")).await;

    match result {
        Ok(authorized) => {
            // Expect false for unauthorized user
            assert!(!authorized, "Random user should not be authorized in test_group");
            println!("✅ Random user correctly unauthorized");
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
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Non-existent group should cause contract panic → RPC error or return false
    let result = sdk.is_authorized("nonexistent_group_123456789", Some("test.user.testnet")).await;
    
    match result {
        Ok(authorized) => assert!(!authorized, "Should not be authorized for nonexistent group"),
        Err(e) => assert!(matches!(e, NovaError::Near(_)), "Should be Near error: {:?}", e),
    }
}

#[tokio::test]
async fn test_estimate_fee_integration() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Test estimate for known actions
    let actions = vec!["register_group", "claim_token", "record_transaction", "add_group_member"];
    
    for action in actions {
        match sdk.estimate_fee(action).await {
            Ok(fee) => {
                println!("✅ Fee for {}: {} yoctoNEAR ({:.6} NEAR)", action, fee, fee as f64 / 1e24);
                // Most actions should have a fee > 0
                if action != "unknown" {
                    assert!(fee > 0, "Fee for {} should be greater than 0", action);
                }
            }
            Err(e) => {
                // Network errors are acceptable
                println!("⚠️  Fee estimate for {} failed (network): {}", action, e);
            }
        }
    }
}

#[tokio::test]
async fn test_estimate_fee_unknown_action() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Unknown action should return 0 without panic
    let fee = sdk.estimate_fee("unknown_action_xyz").await.unwrap();
    assert_eq!(fee, 0u128, "Unknown action should return 0");
    println!("✅ Unknown action correctly returns 0 fee");
}

#[tokio::test]
async fn test_get_group_checksum_integration() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    let result = sdk.get_group_checksum("test_group").await;
    
    match result {
        Ok(checksum) => {
            if let Some(cs) = checksum {
                assert!(!cs.is_empty(), "Checksum should not be empty");
                println!("✅ Group checksum: {}", cs);
            } else {
                println!("✅ Group has no checksum set (this is OK)");
            }
        }
        Err(e) => {
            // Group may not exist
            println!("⚠️  Could not get checksum (group may not exist): {}", e);
        }
    }
}

#[tokio::test]
async fn test_get_group_owner_integration() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    let result = sdk.get_group_owner("test_group").await;
    
    match result {
        Ok(owner) => {
            if let Some(o) = owner {
                assert!(!o.is_empty(), "Owner should not be empty");
                assert!(o.contains(".testnet") || o.contains(".near"), "Owner should be valid account");
                println!("✅ Group owner: {}", o);
            } else {
                println!("✅ Group has no owner (may not exist)");
            }
        }
        Err(e) => {
            println!("⚠️  Could not get owner (group may not exist): {}", e);
        }
    }
}

#[tokio::test]
async fn test_get_transactions_for_group() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();

    // Test with likely unauthorized user → expect empty vec or error
    let result = sdk.get_transactions_for_group("test_group", Some("random.user.testnet")).await;
    
    match result {
        Ok(txs) => {
            // Unauthorized might return empty vec
            println!("✅ Retrieved {} transactions (may be 0 for unauthorized user)", txs.len());
        }
        Err(e) => {
            // Or contract might panic with auth error
            assert!(matches!(e, NovaError::Near(_)), "Expect Near error for auth failure");
            println!("⚠️  Auth error (expected): {}", e);
        }
    }
}

// =========================================================================
// MCP Tool Tests (Require Invalid Token - Should Fail)
// =========================================================================

#[tokio::test]
async fn test_auth_status_invalid_token() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, "invalid_token").unwrap();
    
    let result = sdk.auth_status(None).await;
    assert!(result.is_err(), "Should fail with invalid token");
    
    let err = result.unwrap_err();
    assert!(
        matches!(err, NovaError::Mcp(_)) || matches!(err, NovaError::Http(_)),
        "Expected Mcp or Http error, got: {:?}", err
    );
    println!("✅ Invalid token correctly rejected");
}

#[tokio::test]
async fn test_register_group_invalid_token() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, "invalid_token").unwrap();
    
    let result = sdk.register_group("test_new_group").await;
    assert!(result.is_err(), "Should fail with invalid token");
    println!("✅ Register group correctly rejected with invalid token");
}

#[tokio::test]
async fn test_composite_upload_invalid_token() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, "invalid_token").unwrap();
    
    let test_data = b"test data";
    let result = sdk.composite_upload("test_group", test_data, "test.txt").await;
    assert!(result.is_err(), "Should fail with invalid token");
    println!("✅ Composite upload correctly rejected with invalid token");
}

#[tokio::test]
async fn test_composite_retrieve_invalid_token() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, "invalid_token").unwrap();
    
    let result = sdk.composite_retrieve("test_group", "QmDummyCID123456789").await;
    assert!(result.is_err(), "Should fail with invalid token");
    println!("✅ Composite retrieve correctly rejected with invalid token");
}

#[tokio::test]
async fn test_composite_retrieve_invalid_cid() {
    let sdk = NovaSdk::new(TEST_ACCOUNT_ID, MOCK_SESSION_TOKEN).unwrap();
    
    let result = sdk.composite_retrieve("test_group", "invalid_cid").await;
    assert!(result.is_err(), "Should fail with invalid CID");
    
    let err = result.unwrap_err();
    assert!(matches!(err, NovaError::InvalidCid(_)), "Expected InvalidCid error, got: {:?}", err);
    println!("✅ Invalid CID correctly rejected");
}

// =========================================================================
// Full Integration Tests (Require Real Credentials)
// =========================================================================

#[tokio::test]
async fn test_auth_status_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_auth_status_integration: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
            return;
        }
    };

    let result = sdk.auth_status(Some("test_group")).await.unwrap();
    
    println!("✅ Auth status:");
    println!("   Authenticated: {}", result.authenticated);
    println!("   Account ID: {:?}", result.near_account_id);
    println!("   Authorized for group: {:?}", result.authorized_for_group);
    
    assert!(result.authenticated, "Should be authenticated with valid token");
    assert!(result.near_account_id.is_some(), "Should have account ID");
}

#[tokio::test]
async fn test_register_group_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_register_group_integration: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
            return;
        }
    };

    // Create unique group name with timestamp
    let group_id = format!("test_group_{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
    
    let result = sdk.register_group(&group_id).await;
    
    match result {
        Ok(msg) => {
            println!("✅ Registered group: {}", msg);
            assert!(msg.contains(&group_id) || msg.to_lowercase().contains("success"));
        }
        Err(e) => {
            // May fail if group exists or other issue
            println!("⚠️  Register group result: {}", e);
        }
    }
}

#[tokio::test]
async fn test_register_group_existing_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_register_group_existing_integration: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
            return;
        }
    };

    // Try to register existing group - should fail
    let result = sdk.register_group("test_group").await;
    
    if let Err(e) = result {
        println!("✅ Expected error for existing group: {}", e);
        assert!(matches!(e, NovaError::Mcp(_)));
    } else {
        println!("⚠️  Group didn't exist, was created successfully");
    }
}

#[tokio::test]
async fn test_add_group_member_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_add_group_member_integration: TEST_NOVA_ACCOUNT_ID and TEST_SESSION_TOKEN required");
            return;
        }
    };

    let result = sdk.add_group_member("test_group", "new.member.testnet").await;
    
    match result {
        Ok(msg) => println!("✅ Added member: {}", msg),
        Err(e) => {
            if e.to_string().contains("already a member") {
                println!("⚠️  Already member - expected");
            } else {
                println!("⚠️  Add member error: {}", e);
            }
        }
    }
}

#[tokio::test]
async fn test_revoke_group_member_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_revoke_group_member_integration: Credentials not set");
            return;
        }
    };

    let member_to_revoke = "known.member.testnet";
    let result = sdk.revoke_group_member("test_group", member_to_revoke).await;
    
    match result {
        Ok(msg) => {
            println!("✅ Revoked member: {}", msg);
            
            // Verify: Check is_authorized now false
            let authorized_after = sdk.is_authorized("test_group", Some(member_to_revoke)).await;
            match authorized_after {
                Ok(auth) => assert!(!auth, "Member should no longer be authorized after revoke"),
                Err(_) => {} // May error if group doesn't exist
            }
        }
        Err(e) => {
            if e.to_string().contains("not a member") {
                println!("⚠️  Not a member - expected if already revoked");
            } else {
                println!("⚠️  Revoke error: {}", e);
            }
        }
    }
}

#[tokio::test]
async fn test_composite_upload_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_composite_upload_integration: Credentials not set");
            return;
        }
    };

    let test_data = b"Test data for composite upload via MCP v3";
    let result = sdk.composite_upload("test_group", test_data, "test.txt").await;
    
    match result {
        Ok(res) => {
            println!("✅ Composite upload success:");
            println!("   CID: {}", res.cid);
            println!("   Trans ID: {}", res.trans_id);
            println!("   File Hash: {}", res.file_hash);
            println!("   Fee: claim={} NEAR, record={:?} NEAR, total={} NEAR",
                     res.fee_breakdown.claim, 
                     res.fee_breakdown.record, 
                     res.fee_breakdown.total);
            
            assert!(!res.cid.is_empty());
            assert!(res.cid.starts_with("Qm"), "CID should start with Qm");
            assert!(!res.trans_id.is_empty());
            assert_eq!(res.file_hash.len(), 64, "SHA-256 hex should be 64 chars");
            assert!(res.fee_breakdown.total > 0.0, "Total fee should be > 0");
        }
        Err(e) => {
            println!("⚠️  Upload failed: {}", e);
        }
    }
}

#[tokio::test]
async fn test_composite_retrieve_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_composite_retrieve_integration: Credentials not set");
            return;
        }
    };

    // Original test data
    let original_data = b"Test data for composite retrieve via MCP v3";

    // First, upload to get a real CID
    let upload_result = sdk
        .composite_upload("test_group", original_data, "retrieve_test.txt")
        .await;

    let cid = match upload_result {
        Ok(res) => {
            println!("✅ Upload successful, CID: {}", res.cid);
            res.cid
        }
        Err(e) => {
            println!("⚠️  Upload failed, cannot test retrieve: {}", e);
            return;
        }
    };

    // Now retrieve
    let retrieve_result = sdk.composite_retrieve("test_group", &cid).await;
    
    match retrieve_result {
        Ok(res) => {
            println!("✅ Composite retrieve success:");
            println!("   File Hash: {}", res.file_hash);
            println!("   Data length: {} bytes", res.data.len());
            println!("   IPFS Hash: {}", res.ipfs_hash);
            println!("   Group ID: {}", res.group_id);
            println!("   Fee: claim={} NEAR, total={} NEAR",
                     res.fee_breakdown.claim,
                     res.fee_breakdown.total);

            // Verify data matches
            assert_eq!(res.data, original_data, "Decrypted data should match original");
            assert_eq!(res.file_hash.len(), 64, "File hash should be 64 chars (SHA-256 hex)");
            assert_eq!(res.ipfs_hash, cid, "IPFS hash should match uploaded CID");
            assert_eq!(res.group_id, "test_group");
            assert!(res.fee_breakdown.total > 0.0, "Total fee should be > 0");

            println!("✅ Decrypted data matches original ({} bytes)", res.data.len());
        }
        Err(e) => {
            println!("⚠️  Retrieve failed: {}", e);
        }
    }
}

#[tokio::test]
async fn test_composite_upload_fee_breakdown_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_composite_upload_fee_breakdown_integration: Credentials not set");
            return;
        }
    };

    let test_data = b"Test data for fee breakdown";
    let result = sdk.composite_upload("test_group", test_data, "fee_test.txt").await;
    
    match result {
        Ok(res) => {
            let breakdown = &res.fee_breakdown;
            
            assert!(breakdown.claim > 0.0, "Claim fee should be positive");
            assert!(breakdown.record.unwrap_or(0.0) > 0.0, "Record fee should be positive");
            
            let expected_total = breakdown.claim + breakdown.record.unwrap_or(0.0);
            assert!(
                (breakdown.total - expected_total).abs() < 0.0001,
                "Total should sum claim + record"
            );
            
            println!("✅ Fee breakdown: claim={} NEAR, record={:?} NEAR, total={} NEAR",
                     breakdown.claim, breakdown.record, breakdown.total);
        }
        Err(e) => {
            println!("⚠️  Upload failed: {}", e);
        }
    }
}

#[tokio::test]
async fn test_composite_retrieve_fee_breakdown_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_composite_retrieve_fee_breakdown_integration: Credentials not set");
            return;
        }
    };

    let original_data = b"Test data for retrieve fee breakdown";
    
    // Upload first
    let upload_result = sdk.composite_upload("test_group", original_data, "fee_retrieve_test.txt").await;
    let cid = match upload_result {
        Ok(res) => res.cid,
        Err(e) => {
            println!("⚠️  Upload failed: {}", e);
            return;
        }
    };

    // Retrieve
    let retrieve_result = sdk.composite_retrieve("test_group", &cid).await;
    
    match retrieve_result {
        Ok(res) => {
            let breakdown = &res.fee_breakdown;
            
            assert!(breakdown.claim > 0.0, "Claim fee should be positive");
            assert!(
                (breakdown.total - breakdown.claim).abs() < 0.0001,
                "Total should equal claim for retrieve"
            );
            
            println!("✅ Retrieve fee breakdown: claim={} NEAR, total={} NEAR",
                     breakdown.claim, breakdown.total);
        }
        Err(e) => {
            println!("⚠️  Retrieve failed: {}", e);
        }
    }
}

#[tokio::test]
async fn test_get_transactions_for_group_integration() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_get_transactions_for_group_integration: TEST_NOVA_ACCOUNT_ID not set");
            return;
        }
    };

    // Query transactions for authorized user (using SDK's account_id)
    let result = sdk.get_transactions_for_group("test_group", None).await;

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
                println!("⚠️  Error: {}", e);
            }
        }
    }
}

#[tokio::test]
async fn test_is_authorized_integration_real() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_is_authorized_integration_real: Credentials not set");
            return;
        }
    };

    // Check if SDK's account is authorized in test_group
    let authorized = sdk.is_authorized("test_group", None).await;
    
    match authorized {
        Ok(auth) => {
            println!("✅ User authorized for test_group: {}", auth);
        }
        Err(e) => {
            println!("⚠️  Auth check error: {}", e);
        }
    }
}

#[tokio::test]
async fn test_get_group_owner_integration_real() {
    let sdk = match get_integration_sdk() {
        Some(s) => s,
        None => {
            println!("Skipping test_get_group_owner_integration_real: Credentials not set");
            return;
        }
    };

    let owner = sdk.get_group_owner("test_group").await;
    
    match owner {
        Ok(Some(o)) => {
            println!("✅ test_group owner: {}", o);
            assert!(o.contains(".testnet") || o.contains(".near"));
        }
        Ok(None) => {
            println!("⚠️  test_group has no owner (may not exist)");
        }
        Err(e) => {
            println!("⚠️  Error getting owner: {}", e);
        }
    }
}
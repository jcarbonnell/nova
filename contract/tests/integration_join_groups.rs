// ============================================================================
// nova/contract/tests/test_join_group.rs
// Integration tests for join_group, modeled on test_basics.rs.
// Same FastNEAR RPC + near-workspaces pattern.
// ============================================================================

use near_workspaces;
use near_workspaces::types::{NearToken, Gas};
use near_sdk::serde_json::json;
use std::error::Error;

// Sandbox: a local, ephemeral NEAR node with its own unlimited faucet.
async fn testnet_worker() -> Result<near_workspaces::Worker<near_workspaces::network::Sandbox>, Box<dyn Error>> {
    let worker = near_workspaces::sandbox().await?;
    Ok(worker)
}

// ---------------------------------------------------------------------------
// TEST 1 — fresh contract, full join happy path + security invariant
// ---------------------------------------------------------------------------
#[tokio::test]
async fn join_group_flow_on_fresh_contract() -> Result<(), Box<dyn Error>> {
    let contract_wasm = near_workspaces::compile_project("./").await?;
    let worker = testnet_worker().await?;

    let owner = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;

    let contract = owner.deploy(&contract_wasm).await?.unwrap();

    owner.call(contract.id(), "new")
        .args_json(json!({
            "owner": owner.id().to_string(),
            "shade_contract_id": "ac-sandbox.nova-shade-agent.testnet",
            "fee_recipient": "nova-sdk-4.testnet"
        }))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    // Set the join_group fee (mirrors the real post-deploy step)
    owner.call(contract.id(), "set_fee")
        .args_json(json!({"action":"join_group","fee_yocto":"1000000000000000000"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    println!("✅ join_group fee set");

    // Register a JOINABLE group
    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id": "hack_evt", "joinable": true}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    println!("✅ joinable group registered");

    // is_group_joinable view
    let joinable: bool = contract.view("is_group_joinable")
        .args_json(json!({"group_id":"hack_evt"})).await?.json()?;
    assert!(joinable, "group should be joinable");

    // Open the join window (expires far in the future: now + 1 hour in ns)
    // Use a large absolute ns timestamp; testnet block_timestamp is ~now.
    // Safer: read nothing, just pass a very large expiry.
    let far_future: u64 = 9_999_999_999_000_000_000; // year ~2286 in ns
    owner.call(contract.id(), "open_hackathon_join")
        .args_json(json!({"group_id":"hack_evt","expires_at": far_future.to_string(), "max_uses": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    println!("✅ join window opened");

    // get_join_window view
    let window: Option<serde_json::Value> = contract.view("get_join_window")
        .args_json(json!({"group_id":"hack_evt"})).await?.json()?;
    assert!(window.is_some(), "window should exist");
    assert_eq!(window.unwrap()["open"], true);

    // SECURITY INVARIANT: register a NON-joinable group and prove it can't open
    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id":"private_grp","joinable": false}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    let open_private = owner.call(contract.id(), "open_hackathon_join")
        .args_json(json!({"group_id":"private_grp","expires_at": far_future.to_string(), "max_uses": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100)).transact().await?;
    assert!(open_private.into_result().is_err(),
        "SECURITY: non-joinable group must NOT be openable");
    println!("✅ SECURITY INVARIANT: non-joinable group refused open");

    // Stranger self-joins the joinable group
    stranger.call(contract.id(), "join_group")
        .args_json(json!({"group_id":"hack_evt"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000)) // 0.001 fee
        .gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    println!("✅ stranger self-joined");

    // Stranger is now authorized
    let authorized: bool = contract.view("is_authorized")
        .args_json(json!({"group_id":"hack_evt","user_id": stranger.id().to_string()}))
        .await?.json()?;
    assert!(authorized, "stranger should be a member after join");

    // Window uses incremented
    let window: serde_json::Value = contract.view("get_join_window")
        .args_json(json!({"group_id":"hack_evt"})).await?.json()?;
    assert_eq!(window["uses"], 1);

    // Double-join must fail
    let double = stranger.call(contract.id(), "join_group")
        .args_json(json!({"group_id":"hack_evt"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(200)).transact().await?;
    assert!(double.into_result().is_err(), "double-join must fail");
    println!("✅ double-join refused");

    println!("\n🎉 join_group fresh-contract flow passed");
    Ok(())
}

// ---------------------------------------------------------------------------
// TEST 2 — THE UPGRADE TEST (T2.14). The only proof that no existing state
// bricks. Deploy OLD wasm, create state, upgrade to NEW wasm, assert survival.
//
// REQUIREMENT: you need the OLD (pre-change, v0.3.1) compiled wasm on disk.
// Build it from a clean checkout of the current deployed code and save it as
// tests/res/nova_old.wasm BEFORE applying our edits — OR use the wasm currently
// deployed on mainnet (download via `near ...` or keep the last release artifact).
// ---------------------------------------------------------------------------
#[tokio::test]
async fn upgrade_preserves_legacy_state() -> Result<(), Box<dyn Error>> {
    let worker = testnet_worker().await?;
    let owner = worker.dev_create_account().await?;
    let member = worker.dev_create_account().await?;

    // 1. Deploy OLD wasm (pre-change). Load from tests/res/nova_old.wasm.
    let old_wasm = std::fs::read("tests/res/nova_old.wasm")
        .expect("place the pre-change wasm at tests/res/nova_old.wasm");
    let contract = owner.deploy(&old_wasm).await?.unwrap();

    owner.call(contract.id(), "new")
        .args_json(json!({
            "owner": owner.id().to_string(),
            "shade_contract_id": "ac-sandbox.nova-shade-agent.testnet",
            "fee_recipient": "nova-sdk-4.testnet"
        }))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    // 2. Create legacy state with the OLD signature (one arg — no joinable).
    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id": "legacy_grp"})) // OLD signature
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    owner.call(contract.id(), "add_group_member")
        .args_json(json!({"group_id":"legacy_grp","user_id": member.id().to_string()}))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))
        .gas(Gas::from_tgas(200)).transact().await?.into_result()?;

    member.call(contract.id(), "record_transaction")
        .args_json(json!({"group_id":"legacy_grp","user_id": member.id().to_string(),
                          "file_hash":"legacy_fh","ipfs_hash":"legacy_cid"}))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    println!("✅ legacy state created on OLD contract");

    // 3. UPGRADE: deploy the NEW wasm over the same account (state preserved).
    let new_wasm = near_workspaces::compile_project("./").await?;
    owner.deploy(&new_wasm).await?.unwrap();
    println!("✅ upgraded to NEW contract code");
    owner.call(contract.id(), "migrate")
        .args_json(json!({}))
        .gas(Gas::from_tgas(300))
        .transact().await?.into_result()?;
    println!("✅ migrate() ran");

    // 4. Assert legacy state STILL READS (no brick).
    let owner_of: String = contract.view("get_group_owner")
        .args_json(json!({"group_id":"legacy_grp"})).await?.json()?;
    assert_eq!(owner_of, owner.id().to_string(), "legacy group owner must survive");

    let still_member: bool = contract.view("is_authorized")
        .args_json(json!({"group_id":"legacy_grp","user_id": member.id().to_string()}))
        .await?.json()?;
    assert!(still_member, "legacy membership must survive upgrade");

    // transactions still readable (signed/paid read as member)
    let txs: Vec<serde_json::Value> = member.call(contract.id(), "get_transactions_for_group")
        .args_json(json!({"group_id":"legacy_grp"}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000))
        .gas(Gas::from_tgas(50)).transact().await?.into_result()?.json()?;
    assert_eq!(txs.len(), 1, "legacy transaction must survive");
    assert_eq!(txs[0]["file_hash"], "legacy_fh");
    println!("✅ legacy group/member/transaction all survive upgrade");

    // 5. Assert legacy group is NON-joinable and CANNOT be opened.
    let joinable: bool = contract.view("is_group_joinable")
        .args_json(json!({"group_id":"legacy_grp"})).await?.json()?;
    assert!(!joinable, "legacy group must be non-joinable");

    let far_future: u64 = 9_999_999_999_000_000_000;
    let open_attempt = owner.call(contract.id(), "open_hackathon_join")
        .args_json(json!({"group_id":"legacy_grp","expires_at": far_future.to_string(), "max_uses": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100)).transact().await?;
    assert!(open_attempt.into_result().is_err(),
        "SECURITY: legacy group must NOT be openable for join");
    println!("✅ legacy group correctly non-joinable and unopenable");

    // 6. NEW functionality works on the upgraded contract.
    owner.call(contract.id(), "set_fee")
        .args_json(json!({"action":"join_group","fee_yocto":"1000000000000000000"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(50)).transact().await?.into_result()?;

    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id":"new_hack","joinable": true}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    owner.call(contract.id(), "open_hackathon_join")
        .args_json(json!({"group_id":"new_hack","expires_at": far_future.to_string(),"max_uses": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    member.call(contract.id(), "join_group")
        .args_json(json!({"group_id":"new_hack"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    let joined: bool = contract.view("is_authorized")
        .args_json(json!({"group_id":"new_hack","user_id": member.id().to_string()}))
        .await?.json()?;
    assert!(joined, "new join flow must work post-upgrade");
    println!("✅ new join_group flow works on upgraded contract");

        println!("\n🎉 UPGRADE TEST PASSED — no brick, legacy safe, new features live");
    Ok(())
}

// ---------------------------------------------------------------------------
// TEST 3 — THE §5.6 DEPLOY GATE. Deploy the CURRENT MAINNET wasm (v0.3.2,
// 15-field, tests/res/nova_v032.wasm), create real state, upgrade to the §5.6
// wasm, and prove:
//   (a) NO migrate() is needed — the state struct is byte-identical (§5.6 adds
//       only view methods, which are not part of borsh state);
//   (b) existing data still reads through the ORIGINAL signed methods;
//   (c) a JOINABLE group's data reads through the NEW public views;
//   (d) a NON-joinable (private) group REFUSES the public views (panics) —
//       the core §5.6 security invariant, against real upgraded state.
//
// REQUIREMENT: tests/res/nova_v032.wasm must be the pre-§5.6 v0.3.2 build
// (built from `git stash`-ed source; verified `grep -c get_group_members_public`
// == 0). This is the honest gate for the mainnet redeploy: it proves deploying
// §5.6 over live v0.3.2 state does not brick and the views behave as designed.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn upgrade_v032_to_public_views() -> Result<(), Box<dyn Error>> {
    let worker = testnet_worker().await?;
    let owner = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;

    // 1. Deploy the CURRENT v0.3.2 wasm (what's live on nova-sdk.near today).
    let v032_wasm = std::fs::read("tests/res/nova_v032.wasm")
        .expect("place the pre-§5.6 v0.3.2 wasm at tests/res/nova_v032.wasm");
    let contract = owner.deploy(&v032_wasm).await?.unwrap();

    owner.call(contract.id(), "new")
        .args_json(json!({
            "owner": owner.id().to_string(),
            "shade_contract_id": "ac-sandbox.nova-shade-agent.testnet",
            "fee_recipient": "nova-sdk-4.testnet"
        }))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    let far_future: u64 = 9_999_999_999_000_000_000;

    // 2. Create state on v0.3.2: one PRIVATE group (joinable:false) with a
    //    transaction, and one JOINABLE group with a self-joined member + tx.
    //    Both use the two-arg register_group that v0.3.2 supports.

    // --- private group: owner is auto-member, records a tx ---
    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id": "priv_grp", "joinable": false}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    owner.call(contract.id(), "record_transaction")
        .args_json(json!({"group_id":"priv_grp","user_id": owner.id().to_string(),
                          "file_hash":"priv_fh","ipfs_hash":"priv_cid"}))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    // --- joinable group: open window, stranger self-joins, owner records a tx ---
    owner.call(contract.id(), "set_fee")
        .args_json(json!({"action":"join_group","fee_yocto":"1000000000000000000"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(50)).transact().await?.into_result()?;
    owner.call(contract.id(), "register_group")
        .args_json(json!({"group_id": "pub_grp", "joinable": true}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    owner.call(contract.id(), "open_hackathon_join")
        .args_json(json!({"group_id":"pub_grp","expires_at": far_future.to_string(), "max_uses": null}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100)).transact().await?.into_result()?;
    stranger.call(contract.id(), "join_group")
        .args_json(json!({"group_id":"pub_grp"}))
        .deposit(NearToken::from_yoctonear(1_000_000_000_000_000_000))
        .gas(Gas::from_tgas(200)).transact().await?.into_result()?;
    owner.call(contract.id(), "record_transaction")
        .args_json(json!({"group_id":"pub_grp","user_id": owner.id().to_string(),
                          "file_hash":"pub_fh","ipfs_hash":"pub_cid"}))
        .deposit(NearToken::from_yoctonear(10_000_000_000_000_000_000))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    println!("✅ v0.3.2 state created: 1 private group + 1 joinable group, each with a tx");

    // 3. UPGRADE to §5.6 wasm. NO migrate(): struct is byte-identical (views only).
    //    A green run WITHOUT migrate() is the proof that no migration is needed.
    let new_wasm = near_workspaces::compile_project("./").await?;
    owner.deploy(&new_wasm).await?.unwrap();
    println!("✅ upgraded to §5.6 contract code (no migrate needed)");

    // 4. (b) Existing data still reads through the ORIGINAL signed methods.
    let signed_priv_txs: Vec<serde_json::Value> = owner
        .call(contract.id(), "get_transactions_for_group")
        .args_json(json!({"group_id":"priv_grp"}))
        .deposit(NearToken::from_yoctonear(100_000_000_000_000_000))
        .gas(Gas::from_tgas(50)).transact().await?.into_result()?.json()?;
    assert_eq!(signed_priv_txs.len(), 1, "legacy signed read must survive upgrade");
    assert_eq!(signed_priv_txs[0]["file_hash"], "priv_fh");
    println!("✅ (b) original signed read still works on upgraded state");

    // 5. (c) The JOINABLE group's data reads through the NEW public views —
    //        free (no deposit), no signer authorization required.
    let pub_members: Vec<serde_json::Value> = contract
        .view("get_group_members_public")
        .args_json(json!({"group_id":"pub_grp"})).await?.json()?;
    assert_eq!(pub_members.len(), 2, "owner + stranger");
    assert!(pub_members.iter().any(|m| m == &json!(owner.id().to_string())));
    assert!(pub_members.iter().any(|m| m == &json!(stranger.id().to_string())));

    let pub_txs: Vec<serde_json::Value> = contract
        .view("get_transactions_for_group_public")
        .args_json(json!({"group_id":"pub_grp"})).await?.json()?;
    assert_eq!(pub_txs.len(), 1);
    assert_eq!(pub_txs[0]["file_hash"], "pub_fh");
    assert_eq!(pub_txs[0]["ipfs_hash"], "pub_cid");
    println!("✅ (c) new public views work on the joinable group (free, unsigned)");

    // 6. (d) THE SECURITY INVARIANT: the PRIVATE group REFUSES the public views.
    //        Panic (view returns Err), not empty — an auditor can distinguish
    //        "refused because private" from "genuinely empty".
    let refused_members = contract
        .view("get_group_members_public")
        .args_json(json!({"group_id":"priv_grp"})).await;
    assert!(refused_members.is_err(),
        "SECURITY: public members view must REFUSE a non-joinable group");

    let refused_txs = contract
        .view("get_transactions_for_group_public")
        .args_json(json!({"group_id":"priv_grp"})).await;
    assert!(refused_txs.is_err(),
        "SECURITY: public tx view must REFUSE a non-joinable group");
    println!("✅ (d) SECURITY INVARIANT: private group refuses public views on real upgraded state");

    println!("\n🎉 §5.6 DEPLOY GATE PASSED — no migrate, signed reads intact, public views correct, private groups refused");
    Ok(())
}
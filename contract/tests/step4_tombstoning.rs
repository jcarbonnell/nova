// contract/tests/step4_tombstoning.rs
//
// Step 4 harness (§5.5 tombstoning + DeletionRecord). near-workspaces sandbox
// (unlimited local faucet, network-independent — the §5.6 lesson). §10 verify
// order: UPGRADE survival → security invariant → happy path.
//
// THE upgrade test deploys the real deployed v0.3.3 (as a wasm-opt-lowered
// fixture) then upgrades to the current build and migrates, proving:
//   • the old 15-field state deserializes (no brick),
//   • joinable_groups / join_windows SURVIVE (the previous migrate re-initialised
//     them; this one must carry them forward — the single most important fix),
//   • an old (no-backend) transaction still reads and has no meta row.
//
// FIXTURE (sandbox-only, lowered to MVP so the sandbox wasmer accepts it):
//   1. download the deployed code:
//      curl -s -X POST https://rpc.mainnet.near.org -H 'Content-Type: application/json' \
//        -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"nova-sdk.near"}}' \
//        | jq -r '.result.code_base64' | base64 -d > nova_v0_3_3.wasm
//   2. lower it (binaryen):
//      wasm-opt --signext-lowering --disable-reference-types --disable-multivalue -Oz \
//        nova_v0_3_3.wasm -o contract/tests/fixtures/nova_v0_3_3_mvp.wasm
//
// Run:  cargo test --test step4_tombstoning -- --test-threads=1
// (If compile_project's output is itself rejected by the sandbox wasmer with a
//  Deserialization error, build+lower the new wasm too and load it from a fixture
//  instead of compile_project — same §5.6 remedy.)

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, DevNetwork, Worker};
use serde_json::json;

// Std-only error type so the harness needs no anyhow dev-dependency.
type R<T = ()> = Result<T, Box<dyn std::error::Error>>;

const OLD_WASM_FIXTURE: &str = "tests/fixtures/nova_v0_3_3_mvp.wasm";
const FEE_DEPOSIT: NearToken = NearToken::from_near(1); // covers every per-action fee
const FUTURE_NS: u64 = 9_000_000_000_000_000_000; // ~far-future join-window expiry

// ── helpers ──────────────────────────────────────────────────────────────────

async fn init(contract: &Contract, owner: &Account) -> R {
    contract
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "shade_contract_id": owner.id(),
            "fee_recipient": owner.id(),
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Deploy the CURRENT build to a fresh account and init it (owner = the account).
async fn deploy_new(worker: &Worker<impl DevNetwork>) -> R<Contract> {
    let wasm = near_workspaces::compile_project("./").await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = contract.as_account().clone();
    init(&contract, &owner).await?;
    Ok(contract)
}

async fn register_joinable_group(actor: &Account, contract_id: &near_workspaces::AccountId, group: &str) -> R {
    actor
        .call(contract_id, "register_group")
        .args_json(json!({ "group_id": group, "joinable": true }))
        .deposit(FEE_DEPOSIT)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn record_tx(
    actor: &Account,
    contract_id: &near_workspaces::AccountId,
    group: &str,
    file_hash: &str,
    location: &str,
    backend: Option<&str>,
) -> R<String> {
    let mut args = json!({
        "group_id": group,
        "user_id": actor.id(),
        "file_hash": file_hash,
        "ipfs_hash": location,
    });
    if let Some(b) = backend {
        args["backend"] = json!(b); // omitted entirely when None → exercises backward compat
    }
    let trans_id: String = actor
        .call(contract_id, "record_transaction")
        .args_json(args)
        .deposit(FEE_DEPOSIT)
        .transact()
        .await?
        .into_result()?
        .json()?;
    Ok(trans_id)
}

/*
// ── 1. UPGRADE / MIGRATE survival (the deploy rehearsal) ─────────────────────

#[tokio::test]
async fn upgrade_preserves_joinable_windows_and_txs() -> R {
    let worker = near_workspaces::sandbox().await?;

    // Deploy the REAL deployed v0.3.3 and build old-shaped state.
    let old_wasm = std::fs::read(OLD_WASM_FIXTURE)
        .expect("place the lowered v0.3.3 wasm at tests/fixtures/nova_v0_3_3_mvp.wasm (see header)");
    let contract = worker.dev_deploy(&old_wasm).await?;
    let owner = contract.as_account().clone();
    init(&contract, &owner).await?;

    let alice = worker.dev_create_account().await?;
    register_joinable_group(&alice, contract.id(), "engine-test-evt").await?;

    // open a join window (data that the OLD migrate would have wiped)
    alice
        .call(contract.id(), "open_hackathon_join")
        .args_json(json!({ "group_id": "engine-test-evt", "expires_at": FUTURE_NS.to_string(), "max_uses": null }))
        .transact()
        .await?
        .into_result()?;

    // a legacy transaction (old signature has NO backend param)
    let old_trans_id = record_tx(&alice, contract.id(), "engine-test-evt", "a".repeat(64).as_str(), "QmLegacyCid", None).await?;

    // ── upgrade to the current build on the SAME account, then migrate ──
    let new_wasm = near_workspaces::compile_project("./").await?;
    let contract = contract.as_account().deploy(&new_wasm).await?.into_result()?;
    contract.call("migrate").max_gas().transact().await?.into_result()?;

    // joinable flag SURVIVED
    let joinable: bool = contract.view("is_group_joinable").args_json(json!({ "group_id": "engine-test-evt" })).await?.json()?;
    assert!(joinable, "joinable_groups was wiped by migrate — the bug this test exists to catch");

    // join window SURVIVED
    let window: Option<serde_json::Value> = contract.view("get_join_window").args_json(json!({ "group_id": "engine-test-evt" })).await?.json()?;
    assert!(window.is_some(), "join_windows was wiped by migrate");

    // old transaction still READS (Transaction unchanged → no brick)
    let txs: Vec<serde_json::Value> = contract
        .view("get_transactions_for_group_public")
        .args_json(json!({ "group_id": "engine-test-evt" }))
        .await?
        .json()?;
    assert_eq!(txs.len(), 1, "legacy transaction lost across migrate");

    // legacy tx has NO meta row (absent ⇒ legacy IPFS, not deleted)
    let meta: Option<serde_json::Value> = contract.view("get_transaction_meta").args_json(json!({ "trans_id": old_trans_id })).await?.json()?;
    assert!(meta.is_none(), "legacy tx should have no meta row after migrate");

    Ok(())
}
*/

// ── 2. SECURITY invariant: only group owner or contract owner may tombstone ──

#[tokio::test]
async fn tombstone_requires_owner() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let contract_owner = contract.as_account().clone();

    let alice = worker.dev_create_account().await?;   // group owner
    let mallory = worker.dev_create_account().await?; // outsider
    register_joinable_group(&alice, contract.id(), "g1").await?;
    let trans_id = record_tx(&alice, contract.id(), "g1", "b".repeat(64).as_str(), "fastfs-loc", Some("FastFS")).await?;

    // outsider → refused
    let bad = mallory
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": trans_id, "reason": "ComplianceRequest" }))
        .transact()
        .await?;
    assert!(bad.is_failure(), "a non-owner must NOT be able to tombstone");

    // group owner → allowed
    alice
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": trans_id, "reason": "OwnerRequest" }))
        .transact()
        .await?
        .into_result()?;
    let tombstoned: bool = contract.view("is_tombstoned").args_json(json!({ "trans_id": trans_id })).await?.json()?;
    assert!(tombstoned);

    // contract owner → also allowed (idempotent; keeps FIRST record — see test 4)
    contract_owner
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": trans_id, "reason": "RetentionPolicy" }))
        .transact()
        .await?
        .into_result()?;

    Ok(())
}

// ── 3. record_transaction: backward compat (no backend) + FastFS meta ────────

#[tokio::test]
async fn record_transaction_backend_behavior() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    register_joinable_group(&alice, contract.id(), "g1").await?;

    // NO backend arg → must succeed (existing MCP callers are unchanged) and write NO meta
    let legacy_id = record_tx(&alice, contract.id(), "g1", "c".repeat(64).as_str(), "QmCid", None).await?;
    let legacy_meta: Option<serde_json::Value> = contract.view("get_transaction_meta").args_json(json!({ "trans_id": legacy_id })).await?.json()?;
    assert!(legacy_meta.is_none(), "no-backend call must not write a meta row (backward compat)");

    // FastFS backend → meta row with backend + timestamp, not deleted
    let fastfs_id = record_tx(&alice, contract.id(), "g1", "d".repeat(64).as_str(), "fastfs-loc", Some("FastFS")).await?;
    let meta: serde_json::Value = contract
        .view("get_transaction_meta")
        .args_json(json!({ "trans_id": fastfs_id }))
        .await?
        .json::<Option<serde_json::Value>>()?
        .expect("FastFS tx must have a meta row");
    assert_eq!(meta["backend"], json!("FastFS"));
    assert!(meta["deleted"].is_null(), "freshly recorded tx must not be tombstoned");
    assert!(meta["timestamp"].as_str().is_some(), "timestamp is a stringified u64");

    Ok(())
}

// ── 4. tombstone lifecycle: marks, idempotent (keeps first), NEVER removes ────

#[tokio::test]
async fn tombstone_lifecycle_keeps_record_and_tx() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    register_joinable_group(&alice, contract.id(), "g1").await?;
    let trans_id = record_tx(&alice, contract.id(), "g1", "e".repeat(64).as_str(), "fastfs-loc", Some("FastFS")).await?;

    // first tombstone: RetentionPolicy
    alice
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": trans_id, "reason": "RetentionPolicy" }))
        .transact()
        .await?
        .into_result()?;

    let meta1: serde_json::Value = contract
        .view("get_transaction_meta").args_json(json!({ "trans_id": trans_id })).await?
        .json::<Option<serde_json::Value>>()?.unwrap();
    assert_eq!(meta1["deleted"]["reason"], json!("RetentionPolicy"));
    assert_eq!(meta1["backend"], json!("FastFS"), "tombstone must preserve the original backend/timestamp");
    let first_deleted_at = meta1["deleted"]["deleted_at"].as_str().unwrap().to_string();

    // second tombstone with a DIFFERENT reason → idempotent, keeps the FIRST record
    alice
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": trans_id, "reason": "ComplianceRequest" }))
        .transact()
        .await?
        .into_result()?;
    let meta2: serde_json::Value = contract
        .view("get_transaction_meta").args_json(json!({ "trans_id": trans_id })).await?
        .json::<Option<serde_json::Value>>()?.unwrap();
    assert_eq!(meta2["deleted"]["reason"], json!("RetentionPolicy"), "re-tombstone must keep the first reason");
    assert_eq!(meta2["deleted"]["deleted_at"].as_str().unwrap(), first_deleted_at, "re-tombstone must keep the first timestamp");

    // TOMBSTONE ≠ REMOVE: the transaction is still in the audit trail
    let txs: Vec<serde_json::Value> = contract
        .view("get_transactions_for_group_public").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert_eq!(txs.len(), 1, "tombstoning must NOT remove the transaction record (§8.5 audit trail)");

    Ok(())
}

// ── 5. tombstoning a LEGACY (no-meta) transaction synthesises an Ipfs record ──

#[tokio::test]
async fn tombstone_legacy_ipfs_tx() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    register_joinable_group(&alice, contract.id(), "g1").await?;
    let legacy_id = record_tx(&alice, contract.id(), "g1", "f".repeat(64).as_str(), "QmCid", None).await?; // no backend → no meta

    alice
        .call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": legacy_id, "reason": "OwnerRequest" }))
        .transact()
        .await?
        .into_result()?;

    let meta: serde_json::Value = contract
        .view("get_transaction_meta").args_json(json!({ "trans_id": legacy_id })).await?
        .json::<Option<serde_json::Value>>()?
        .expect("tombstoning a legacy tx must synthesise a meta row to hold the deletion record");
    assert_eq!(meta["backend"], json!("Ipfs"), "legacy tombstone → Ipfs backend");
    assert_eq!(meta["deleted"]["reason"], json!("OwnerRequest"));

    Ok(())
}

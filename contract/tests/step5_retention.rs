// contract/tests/step5_retention.rs
//
// Step 5 harness (§6.1 retention window + expiry view, §5.7 batch tombstone).
// near-workspaces sandbox. §10 verify order: UPGRADE survival → security → happy.
//
// THE upgrade test deploys the deployed v0.3.4 (lowered fixture) then upgrades to
// the current build and migrates, proving the v0.3.5 migrate preserves EVERYTHING
// from v0.3.4 — crucially tx_meta (the Step 4 deletion records) — and starts
// retention_windows empty.
//
// FIXTURE (sandbox-only, MVP-lowered — same procedure as Step 4, but the NOW-
// deployed v0.3.4):
//   curl -s -X POST https://rpc.mainnet.near.org -H 'Content-Type: application/json' \
//     -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_code","finality":"final","account_id":"nova-sdk.near"}}' \
//     | jq -r '.result.code_base64' | base64 -d > /tmp/nova_v0_3_4.wasm
//   wasm-opt --signext-lowering --disable-reference-types --disable-multivalue -Oz \
//     /tmp/nova_v0_3_4.wasm -o tests/fixtures/nova_v0_3_4_mvp.wasm
//
// Run:  cargo test --test step5_retention -- --test-threads=1

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, DevNetwork, Worker};
use serde_json::json;

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;

const OLD_WASM_FIXTURE: &str = "tests/fixtures/nova_v0_3_4_mvp.wasm";
const FEE_DEPOSIT: NearToken = NearToken::from_near(1);
const FUTURE_NS: u64 = 9_000_000_000_000_000_000;

async fn init(contract: &Contract, owner: &Account) -> R {
    contract.call("new")
        .args_json(json!({ "owner": owner.id(), "shade_contract_id": owner.id(), "fee_recipient": owner.id() }))
        .transact().await?.into_result()?;
    Ok(())
}

async fn deploy_new(worker: &Worker<impl DevNetwork>) -> R<Contract> {
    let wasm = near_workspaces::compile_project("./").await?;
    let contract = worker.dev_deploy(&wasm).await?;
    let owner = contract.as_account().clone();
    init(&contract, &owner).await?;
    Ok(contract)
}

async fn register_joinable(actor: &Account, contract_id: &near_workspaces::AccountId, group: &str) -> R {
    actor.call(contract_id, "register_group")
        .args_json(json!({ "group_id": group, "joinable": true }))
        .deposit(FEE_DEPOSIT).transact().await?.into_result()?;
    Ok(())
}

async fn record_fastfs(actor: &Account, contract_id: &near_workspaces::AccountId, group: &str, file_hash: &str) -> R<String> {
    let id: String = actor.call(contract_id, "record_transaction")
        .args_json(json!({ "group_id": group, "user_id": actor.id(), "file_hash": file_hash, "ipfs_hash": "fastfs-loc", "backend": "FastFS" }))
        .deposit(FEE_DEPOSIT).transact().await?.into_result()?.json()?;
    Ok(id)
}

// ── 1. UPGRADE v0.3.4 → v0.3.5: everything (incl. tx_meta) survives ──────────

#[tokio::test]
async fn upgrade_v034_to_v035_preserves_all() -> R {
    let worker = near_workspaces::sandbox().await?;
    let old_wasm = std::fs::read(OLD_WASM_FIXTURE)
        .expect("place the lowered v0.3.4 wasm at tests/fixtures/nova_v0_3_4_mvp.wasm (see header)");
    let contract = worker.dev_deploy(&old_wasm).await?;
    let owner = contract.as_account().clone();
    init(&contract, &owner).await?;

    let alice = worker.dev_create_account().await?;
    register_joinable(&alice, contract.id(), "engine-test-evt").await?;
    alice.call(contract.id(), "open_hackathon_join")
        .args_json(json!({ "group_id": "engine-test-evt", "expires_at": FUTURE_NS.to_string(), "max_uses": null }))
        .transact().await?.into_result()?;

    // a FastFS tx, then tombstone it (Step 4 path) → tx_meta holds a deletion record
    let tid = record_fastfs(&alice, contract.id(), "engine-test-evt", &"a".repeat(64)).await?;
    alice.call(contract.id(), "tombstone_transaction")
        .args_json(json!({ "trans_id": tid, "reason": "OwnerRequest" }))
        .transact().await?.into_result()?;

    // ── upgrade + migrate ──
    let new_wasm = near_workspaces::compile_project("./").await?;
    let contract = contract.as_account().deploy(&new_wasm).await?.into_result()?;
    contract.call("migrate").max_gas().transact().await?.into_result()?;

    // v0.3.4 state survived
    let joinable: bool = contract.view("is_group_joinable").args_json(json!({ "group_id": "engine-test-evt" })).await?.json()?;
    assert!(joinable, "joinable_groups wiped");
    let window: Option<serde_json::Value> = contract.view("get_join_window").args_json(json!({ "group_id": "engine-test-evt" })).await?.json()?;
    assert!(window.is_some(), "join_windows wiped");

    // tx_meta (Step 4 deletion record) SURVIVED — the point of this migrate
    let meta: serde_json::Value = contract.view("get_transaction_meta").args_json(json!({ "trans_id": tid })).await?
        .json::<Option<serde_json::Value>>()?.expect("tx_meta lost across v0.3.5 migrate");
    assert_eq!(meta["deleted"]["reason"], json!("OwnerRequest"), "tombstone record lost across migrate");

    // retention starts empty
    let ret: Option<u32> = contract.view("get_group_retention").args_json(json!({ "group_id": "engine-test-evt" })).await?.json()?;
    assert!(ret.is_none(), "retention_windows should start empty");
    Ok(())
}

// ── 2. retention config: owner-gated set/clear ───────────────────────────────

#[tokio::test]
async fn retention_config_owner_gated() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;
    register_joinable(&alice, contract.id(), "g1").await?;

    // outsider → refused
    let bad = mallory.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": 60 })).transact().await?;
    assert!(bad.is_failure(), "non-owner must not set retention");

    // owner set → readable
    alice.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": 60 })).transact().await?.into_result()?;
    let ret: Option<u32> = contract.view("get_group_retention").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert_eq!(ret, Some(60));

    // owner clear (None) → gone
    alice.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": null })).transact().await?.into_result()?;
    let ret: Option<u32> = contract.view("get_group_retention").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert!(ret.is_none());
    Ok(())
}

// ── 3. expiry view: window math, exclusions ──────────────────────────────────

#[tokio::test]
async fn expired_transactions_view() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    register_joinable(&alice, contract.id(), "g1").await?;

    let fastfs_id = record_fastfs(&alice, contract.id(), "g1", &"b".repeat(64)).await?;
    // legacy (no backend) → no meta/timestamp → never expires
    alice.call(contract.id(), "record_transaction")
        .args_json(json!({ "group_id": "g1", "user_id": alice.id(), "file_hash": "c".repeat(64), "ipfs_hash": "QmCid" }))
        .deposit(FEE_DEPOSIT).transact().await?.into_result()?;

    // no retention set → empty
    let none: Vec<String> = contract.view("get_expired_transactions").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert!(none.is_empty(), "no retention ⇒ nothing expired");

    // retention 0 days → the FastFS tx (recorded in a past block) is expired; legacy is not
    alice.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": 0 })).transact().await?.into_result()?;
    let expired: Vec<String> = contract.view("get_expired_transactions").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert_eq!(expired, vec![fastfs_id.clone()], "only the FastFS tx should be expired");

    // huge retention → nothing expired
    alice.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": 3650 })).transact().await?.into_result()?;
    let expired: Vec<String> = contract.view("get_expired_transactions").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert!(expired.is_empty(), "nothing should be expired under a 10-year window");
    Ok(())
}

// ── 4. batch tombstone: count, idempotent, owner-gated, never removes ────────

#[tokio::test]
async fn batch_tombstone() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;
    register_joinable(&alice, contract.id(), "g1").await?;
    let id1 = record_fastfs(&alice, contract.id(), "g1", &"d".repeat(64)).await?;
    let id2 = record_fastfs(&alice, contract.id(), "g1", &"e".repeat(64)).await?;

    // outsider → refused (fail-fast)
    let bad = mallory.call(contract.id(), "tombstone_transactions")
        .args_json(json!({ "trans_ids": [id1, id2], "reason": "RetentionPolicy" })).transact().await?;
    assert!(bad.is_failure(), "non-owner must not batch-tombstone");

    // owner → both newly tombstoned
    let n: u32 = alice.call(contract.id(), "tombstone_transactions")
        .args_json(json!({ "trans_ids": [id1, id2], "reason": "RetentionPolicy" }))
        .transact().await?.into_result()?.json()?;
    assert_eq!(n, 2);
    for id in [&id1, &id2] {
        let t: bool = contract.view("is_tombstoned").args_json(json!({ "trans_id": id })).await?.json()?;
        assert!(t);
    }

    // idempotent re-batch → 0 newly tombstoned
    let n: u32 = alice.call(contract.id(), "tombstone_transactions")
        .args_json(json!({ "trans_ids": [id1, id2], "reason": "ComplianceRequest" }))
        .transact().await?.into_result()?.json()?;
    assert_eq!(n, 0, "re-tombstoning already-deleted txs must count 0");

    // NOT removed — still in the audit trail
    let txs: Vec<serde_json::Value> = contract.view("get_transactions_for_group_public").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert_eq!(txs.len(), 2, "batch tombstone must not remove transactions");
    Ok(())
}

// ── 5. retention end-to-end: expired → batch tombstone ───────────────────────

#[tokio::test]
async fn retention_end_to_end() -> R {
    let worker = near_workspaces::sandbox().await?;
    let contract = deploy_new(&worker).await?;
    let alice = worker.dev_create_account().await?;
    register_joinable(&alice, contract.id(), "g1").await?;
    let tid = record_fastfs(&alice, contract.id(), "g1", &"f".repeat(64)).await?;
    alice.call(contract.id(), "set_group_retention")
        .args_json(json!({ "group_id": "g1", "retention_days": 0 })).transact().await?.into_result()?;

    // the driver's two on-chain calls: read expired, batch tombstone
    let expired: Vec<String> = contract.view("get_expired_transactions").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert_eq!(expired, vec![tid.clone()]);
    let n: u32 = alice.call(contract.id(), "tombstone_transactions")
        .args_json(json!({ "trans_ids": expired, "reason": "RetentionPolicy" }))
        .transact().await?.into_result()?.json()?;
    assert_eq!(n, 1);

    let t: bool = contract.view("is_tombstoned").args_json(json!({ "trans_id": tid })).await?.json()?;
    assert!(t);
    // and it's gone from the expiry set now (deleted excluded)
    let expired: Vec<String> = contract.view("get_expired_transactions").args_json(json!({ "group_id": "g1" })).await?.json()?;
    assert!(expired.is_empty(), "tombstoned tx must drop out of the expiry set");
    Ok(())
}

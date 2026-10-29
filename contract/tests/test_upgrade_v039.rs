// nova/contract/tests/test_upgrade_v039.rs
//
// Upgrade gate for v0.3.9 (§10: harness → testnet upgrade → mainnet). SANDBOX only.
//
//   1. deploy TODAY's mainnet code (v0.3.8, code_hash 6TaWqcZW…, downloaded beforehand)
//   2. seed realistic state, then PROVE THE DRAIN on the old code: a member locks
//      ~100 KB of the contract's storage with one record (no bound, fee 0.002 NEAR)
//   3. snapshot every read path
//   4. redeploy v0.3.9 CODE-ONLY (no migrate call: no state field is added)
//   5. assert the snapshot is identical (the oversized v0.3.8 record stays readable),
//      then: oversized inputs refused by their messages, worker gate, real-runtime
//      worst-case storage per write against the proposed fees
//
// RUN (from contract/):
//   cargo test --test test_upgrade_v039 -- --nocapture
//   (reads ./nova-mainnet-v038.wasm, or NOVA_MAINNET_V038_WASM; refuses any file whose
//    sha256 is not mainnet's v0.3.8 code_hash 6TaWqcZWkMuwHcuRCDjgiM4fTxLy6LJaRTMi1EkN49iU)

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use near_sdk::serde_json::{json, Value};
use std::error::Error;

type R<T = ()> = Result<T, Box<dyn Error>>;

const FEE: NearToken = NearToken::from_millinear(100); // 0.1 NEAR covers every default fee
const BYTE_YOCTO: u128 = 10_000_000_000_000_000_000;  // storage price, 1e19 yocto per byte

// Proposed post-deploy fees (yoctoNEAR) = measured worst-case storage + margin (v039.rs).
const PROPOSED: [(&str, u128); 5] = [
    ("record_transaction", 10_000_000_000_000_000_000_000), // 0.01   (worst 862 B = 0.00862)
    ("add_group_member",    6_000_000_000_000_000_000_000), // 0.006  (worst 547 B)
    ("join_group",          6_000_000_000_000_000_000_000), // 0.006  (worst 547 B)
    ("claim_token",         3_000_000_000_000_000_000_000), // 0.003  (worst 240 B)
    ("update_checksum",     1_000_000_000_000_000_000_000), // 0.001  (worst 68 B)
];

async fn call_dep(who: &Account, c: &Contract, m: &str, args: Value, dep: NearToken)
    -> R<near_workspaces::result::ExecutionFinalResult> {
    Ok(who.call(c.id(), m).args_json(args).deposit(dep).gas(Gas::from_tgas(300)).transact().await?)
}
async fn call(who: &Account, c: &Contract, m: &str, args: Value) -> R<near_workspaces::result::ExecutionFinalResult> {
    call_dep(who, c, m, args, FEE).await
}
async fn ok(who: &Account, c: &Contract, m: &str, args: Value) -> R<Value> {
    let out = call(who, c, m, args.clone()).await?;
    if !out.is_success() {
        return Err(format!("{m} by {} failed: {:?}", who.id(), out.failures()).into());
    }
    Ok(out.json::<Value>().unwrap_or(Value::Null))
}
async fn refused(who: &Account, c: &Contract, m: &str, args: Value, needle: &str) -> R {
    let out = call(who, c, m, args).await?;
    assert!(out.is_failure(), "{m} by {} must be refused", who.id());
    let msg = format!("{:?}", out.failures());
    assert!(msg.contains(needle), "{m} refused, but not with {needle:?}: {}", &msg[..msg.len().min(400)]);
    Ok(())
}
async fn view(c: &Contract, m: &str, args: Value) -> R<Value> {
    Ok(c.view(m).args_json(args).await?.json::<Value>()?)
}
async fn storage(c: &Contract) -> R<u64> {
    Ok(c.view_account().await?.storage_usage)
}

const GROUPS: [&str; 3] = ["seed-group", "open-event", "revoked-group"];

async fn snapshot(c: &Contract, owner: &Account, alice: &Account, agent: &Account) -> R<Value> {
    let mut s = serde_json::Map::new();
    for g in GROUPS {
        s.insert(format!("{g}/owner"), view(c, "get_group_owner", json!({"group_id": g})).await?);
        s.insert(format!("{g}/retention"), view(c, "get_group_retention", json!({"group_id": g})).await?);
        s.insert(format!("{g}/joinable"), view(c, "is_group_joinable", json!({"group_id": g})).await?);
        s.insert(format!("{g}/agent_authorized"),
            view(c, "is_authorized", json!({"group_id": g, "user_id": agent.id()})).await?);
        s.insert(format!("{g}/txs"), ok(alice, c, "get_transactions_for_group", json!({"group_id": g})).await?);
        s.insert(format!("{g}/members"), ok(alice, c, "get_group_members", json!({"group_id": g})).await?);
        s.insert(format!("{g}/members_of_alice"), ok(owner, c, "get_group_members_of",
            json!({"group_id": g, "account_id": alice.id()})).await?);
    }
    s.insert("open-event/txs_public".into(), view(c, "get_transactions_for_group_public", json!({"group_id": "open-event"})).await?);
    s.insert("seed-group/txs_of_agent".into(), ok(owner, c, "get_transactions_for_group_of",
        json!({"group_id": "seed-group", "account_id": agent.id()})).await?);
    s.insert("alice/owned".into(), ok(owner, c, "get_owned_groups_of", json!({"account_id": alice.id()})).await?);
    s.insert("alice/member".into(), ok(owner, c, "get_member_groups_of", json!({"account_id": alice.id()})).await?);
    s.insert("agent/member".into(), ok(owner, c, "get_member_groups_of", json!({"account_id": agent.id()})).await?);
    s.insert("seed-group/checksum".into(), view(c, "get_group_checksum", json!({"group_id": "seed-group"})).await?);
    for (a, _) in PROPOSED {
        s.insert(format!("fee/{a}"), view(c, "estimate_fee", json!({"action": a})).await?);
    }
    Ok(Value::Object(s))
}

fn hash(n: u8) -> String { format!("{n:02x}").repeat(32) }
const LOC: &str = "nova-sdk.near/fastfs.near/8641e048d973ef5c83d1a0088f93638eb5c3f86746ee2d34c4b5cb0430083c5d/6e4b975e-8f98-48c3-bc39-edcd4fc7c500";

#[tokio::test]
async fn upgrade_mainnet_v038_to_v039_code_only() -> R {
    let old_path = std::env::var("NOVA_MAINNET_V038_WASM").unwrap_or_else(|_| "./nova-mainnet-v038.wasm".into());
    let old_wasm = std::fs::read(&old_path).map_err(|e| format!("read {old_path}: {e} (download it first)"))?;
    {
        use sha2::{Digest, Sha256};
        let got = hex::encode(Sha256::digest(&old_wasm));
        // mainnet v0.3.8 code_hash 6TaWqcZWkMuwHcuRCDjgiM4fTxLy6LJaRTMi1EkN49iU, as hex
        assert_eq!(got, "51196e3a6058fca21b9bb2edd8797096a267c4ab9f11c39a1c2936c1933b2f6d",
            "{old_path} is not mainnet's v0.3.8 code: the gate must start from what is deployed");
    }
    let new_wasm = near_workspaces::compile_project("./").await?;
    assert_ne!(old_wasm, new_wasm, "new wasm identical to mainnet: nothing to upgrade?");

    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?; // plays nova-sdk.near: contract account = owner
    let alice = worker.dev_create_account().await?; // a wallet owner
    let agent = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;

    // 1. today's mainnet code (v0.3.8)
    let contract = owner.deploy(&old_wasm).await?.into_result()?;
    contract.call("new")
        .args_json(json!({"owner": owner.id(), "shade_contract_id": owner.id(), "fee_recipient": owner.id()}))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    // 2. seed
    ok(&alice, &contract, "register_group", json!({"group_id": "seed-group"})).await?;
    ok(&alice, &contract, "add_group_member", json!({"group_id": "seed-group", "user_id": agent.id()})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": hash(0xaa), "ipfs_hash": LOC, "backend": "FastFS"})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": hash(0xbb), "ipfs_hash": "QmLegacyCid"})).await?;
    ok(&alice, &contract, "set_group_retention", json!({"group_id": "seed-group", "retention_days": 30})).await?;
    ok(&alice, &contract, "update_checksum", json!({"group_id": "seed-group", "checksum": "ab".repeat(32)})).await?;
    ok(&alice, &contract, "register_group", json!({"group_id": "open-event", "joinable": true})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "open-event", "user_id": alice.id(),
        "file_hash": hash(0xcc), "ipfs_hash": LOC, "backend": "FastFS"})).await?;
    ok(&alice, &contract, "register_group", json!({"group_id": "revoked-group"})).await?;
    ok(&alice, &contract, "add_group_member", json!({"group_id": "revoked-group", "user_id": agent.id()})).await?;
    ok(&agent, &contract, "record_transaction", json!({"group_id": "revoked-group", "user_id": agent.id(),
        "file_hash": hash(0xdd), "ipfs_hash": LOC, "backend": "FastFS"})).await?;
    ok(&alice, &contract, "revoke_group_member", json!({"group_id": "revoked-group", "user_id": agent.id()})).await?;

    // 2b. the drain, on the OLD code: one member record of ~100 KB is accepted and its
    // storage is charged to the contract (a real attack would send ~1.4 MB to empty mainnet's free balance).
    let s0 = storage(&contract).await?;
    ok(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": "z".repeat(50_000), "ipfs_hash": "y".repeat(50_000), "backend": "FastFS"})).await?;
    let drained = storage(&contract).await? - s0;
    assert!(drained > 100_000, "the v0.3.8 drain should be reproducible (got {drained} bytes)");
    println!("⚠️  v0.3.8: one 100 KB record locked {drained} bytes = {:.3} NEAR of the contract's balance, for a 0.002 NEAR fee",
        (drained as u128 * BYTE_YOCTO) as f64 / 1e24);

    // 3. snapshot under the old code (the oversized record is part of it)
    let before = snapshot(&contract, &owner, &alice, &agent).await?;

    // 4. code-only upgrade (no migrate)
    let contract = owner.deploy(&new_wasm).await?.into_result()?;

    // 5a. state intact, including the oversized v0.3.8 record (existing data is never refused)
    let after = snapshot(&contract, &owner, &alice, &agent).await?;
    assert_eq!(before, after, "a read path changed across the upgrade");
    println!("✅ {} read paths identical after the code-only upgrade", before.as_object().map(|m| m.len()).unwrap_or(0));

    // 5b. the drain is closed, each refusal by its own message
    refused(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": "z".repeat(50_000), "ipfs_hash": LOC, "backend": "FastFS"}), "Invalid file_hash").await?;
    refused(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": hash(0xee), "ipfs_hash": "y".repeat(50_000), "backend": "FastFS"}), "Invalid ipfs_hash").await?;
    refused(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": hash(0xee), "ipfs_hash": "y".repeat(161), "backend": "FastFS"}), "expected 1-160 bytes").await?;
    refused(&alice, &contract, "update_checksum", json!({"group_id": "seed-group", "checksum": "ab".repeat(1_000)}),
        "Invalid checksum").await?;
    // register_shade_worker is not #[payable]: call it with NO deposit, or NEAR refuses
    // the deposit before the method runs and the gate is never reached.
    let w = call_dep(&mallory, &contract, "register_shade_worker",
        json!({"worker_id": mallory.id(), "attestation": [0, 0, 0, 0, 0, 0, 0, 0]}), NearToken::from_yoctonear(0)).await?;
    let wmsg = format!("{:?}", w.failures());
    assert!(w.is_failure() && wmsg.contains("Only owner or Shade contract can register workers"),
        "register_shade_worker by a stranger must hit the v0.3.9 gate: {}", &wmsg[..wmsg.len().min(600)]);
    println!("✅ oversized file_hash / location / checksum refused; worker registration closed to strangers");

    // 5c. v0.3.7 / v0.3.8 behaviour unchanged (regression)
    refused(&mallory, &contract, "register_group", json!({"group_id": format!("member:{}", alice.id())}), "Invalid group_id").await?;
    refused(&mallory, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": hash(0xee), "ipfs_hash": LOC, "backend": "FastFS"}), "uploader must be the caller").await?;
    refused(&agent, &contract, "get_group_members_of", json!({"group_id": "seed-group", "account_id": agent.id()}),
        "reader-gated view (owner only)").await?;
    refused(&owner, &contract, "get_transactions_for_group_of",
        json!({"group_id": "revoked-group", "account_id": agent.id()}), "not a member").await?;
    println!("✅ v0.3.7 / v0.3.8 checks still enforced");

    // 5d. the proposed fees, then each write at its fee: the fee covers what it locks
    for (action, fee) in PROPOSED {
        ok(&owner, &contract, "set_fee", json!({"action": action, "fee_yocto": fee.to_string()})).await?;
    }
    let s1 = storage(&contract).await?;
    let fee = |a: &str| NearToken::from_yoctonear(PROPOSED.iter().find(|(n, _)| *n == a).unwrap().1);
    let out = call_dep(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": hash(0x11), "ipfs_hash": "L".repeat(160), "backend": "FastFS"}), fee("record_transaction")).await?;
    assert!(out.is_success(), "record at exactly its fee: {:?}", out.failures());
    let rec = storage(&contract).await? - s1;
    let out = call_dep(&alice, &contract, "add_group_member", json!({"group_id": "seed-group", "user_id": mallory.id()}),
        fee("add_group_member")).await?;
    assert!(out.is_success(), "add at exactly its fee: {:?}", out.failures());
    let add = storage(&contract).await? - s1 - rec;
    println!("✅ real runtime: record (160-byte location) +{rec} B, add_group_member +{add} B");
    assert!((rec as u128) * BYTE_YOCTO <= fee("record_transaction").as_yoctonear(), "record fee must cover its storage");
    assert!((add as u128) * BYTE_YOCTO <= fee("add_group_member").as_yoctonear(), "add fee must cover its storage");
    let short = call_dep(&agent, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": agent.id(),
        "file_hash": hash(0x12), "ipfs_hash": LOC, "backend": "FastFS"}),
        NearToken::from_yoctonear(fee("record_transaction").as_yoctonear() - 1)).await?;
    assert!(short.is_failure() && format!("{:?}", short.failures()).contains("Attach at least"),
        "one yocto short of the fee must be refused");
    println!("✅ proposed fees cover the worst-case storage of each write; one yocto short is refused");

    // 5e. migrate() is harmless if ever called (identity read of the same layout)
    contract.call("migrate").gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    assert_eq!(view(&contract, "get_group_owner", json!({"group_id": "seed-group"})).await?, json!(alice.id()));
    println!("✅ migrate() on the current layout is a no-op");
    Ok(())
}

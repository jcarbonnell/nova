// nova/contract/tests/test_upgrade_v038.rs
//
// Upgrade gate for v0.3.8 (§10: harness → testnet upgrade → mainnet). SANDBOX only.
//
//   1. deploy TODAY's mainnet code (v0.3.7, code_hash CvmHNonv…, downloaded beforehand)
//   2. seed realistic state: a private group with a member, FastFS + legacy records,
//      a retention window, a joinable group, a group whose member was revoked
//   3. snapshot every read path (v0.3.7's reader-gated tx view included)
//   4. redeploy v0.3.8 CODE-ONLY (no migrate call: no state field is added)
//   5. assert the snapshot is identical, then exercise get_group_members_of
//
// RUN (from contract/):
//   cargo test --test test_upgrade_v038 -- --nocapture
//   (reads ./nova-mainnet-v037.wasm, or NOVA_MAINNET_V037_WASM; refuses any file whose
//    sha256 is not mainnet's v0.3.7 code_hash CvmHNonvgFhLc9SbLX2jFZP2CksZorULzsPBCDkiQB33)

use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract};
use near_sdk::serde_json::{json, Value};
use std::error::Error;

type R<T = ()> = Result<T, Box<dyn Error>>;

const FEE: NearToken = NearToken::from_millinear(100); // 0.1 NEAR covers every default fee

async fn call(who: &Account, c: &Contract, m: &str, args: Value) -> R<near_workspaces::result::ExecutionFinalResult> {
    Ok(who.call(c.id(), m).args_json(args).deposit(FEE).gas(Gas::from_tgas(300)).transact().await?)
}

async fn ok(who: &Account, c: &Contract, m: &str, args: Value) -> R<Value> {
    let out = call(who, c, m, args.clone()).await?;
    if !out.is_success() {
        return Err(format!("{m}({args}) by {} failed: {:?}", who.id(), out.failures()).into());
    }
    Ok(out.json::<Value>().unwrap_or(Value::Null))
}

async fn refused(who: &Account, c: &Contract, m: &str, args: Value, needle: &str) -> R {
    let out = call(who, c, m, args.clone()).await?;
    assert!(out.is_failure(), "{m}({args}) by {} must be refused", who.id());
    let msg = format!("{:?}", out.failures());
    assert!(msg.contains(needle), "{m} refused, but not with {needle:?}: {msg}");
    Ok(())
}

async fn view(c: &Contract, m: &str, args: Value) -> R<Value> {
    Ok(c.view(m).args_json(args).await?.json::<Value>()?)
}

const GROUPS: [&str; 3] = ["seed-group", "open-event", "revoked-group"];

/// Every read path whose output must survive the upgrade unchanged.
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
    }
    s.insert("open-event/txs_public".into(), view(c, "get_transactions_for_group_public", json!({"group_id": "open-event"})).await?);
    s.insert("seed-group/txs_of_agent".into(), ok(owner, c, "get_transactions_for_group_of",
        json!({"group_id": "seed-group", "account_id": agent.id()})).await?);
    s.insert("alice/owned".into(), ok(owner, c, "get_owned_groups_of", json!({"account_id": alice.id()})).await?);
    s.insert("alice/member".into(), ok(owner, c, "get_member_groups_of", json!({"account_id": alice.id()})).await?);
    s.insert("agent/member".into(), ok(owner, c, "get_member_groups_of", json!({"account_id": agent.id()})).await?);
    s.insert("fee/register".into(), view(c, "estimate_fee", json!({"action": "register_group"})).await?);
    Ok(Value::Object(s))
}

#[tokio::test]
async fn upgrade_mainnet_v037_to_v038_code_only() -> R {
    let old_path = std::env::var("NOVA_MAINNET_V037_WASM").unwrap_or_else(|_| "./nova-mainnet-v037.wasm".into());
    let old_wasm = std::fs::read(&old_path).map_err(|e| format!("read {old_path}: {e} (download it first)"))?;
    // mainnet v0.3.7 code_hash CvmHNonvgFhLc9SbLX2jFZP2CksZorULzsPBCDkiQB33, as hex
    {
        use sha2::{Digest, Sha256};
        let got = hex::encode(Sha256::digest(&old_wasm));
        assert_eq!(got, "b13668c666a38b6a22e3e32298e53c7a8533d69cdb4131bba58e17293165db66",
            "{old_path} is not mainnet's v0.3.7 code: the gate must start from what is deployed");
    }
    let new_wasm = near_workspaces::compile_project("./").await?;
    assert_ne!(old_wasm, new_wasm, "new wasm identical to mainnet: nothing to upgrade?");

    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?; // plays nova-sdk.near: contract account = owner
    let alice = worker.dev_create_account().await?; // a wallet owner
    let agent = worker.dev_create_account().await?;
    let mallory = worker.dev_create_account().await?;

    // 1. today's mainnet code (v0.3.7)
    let contract = owner.deploy(&old_wasm).await?.into_result()?;
    contract.call("new")
        .args_json(json!({"owner": owner.id(), "shade_contract_id": owner.id(), "fee_recipient": owner.id()}))
        .gas(Gas::from_tgas(300)).transact().await?.into_result()?;

    // 2. seed
    ok(&alice, &contract, "register_group", json!({"group_id": "seed-group"})).await?;
    ok(&alice, &contract, "add_group_member", json!({"group_id": "seed-group", "user_id": agent.id()})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": "aa".repeat(32), "ipfs_hash": "nova-sdk.near/fastfs.near/x/1", "backend": "FastFS"})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": "bb".repeat(32), "ipfs_hash": "QmLegacyCid"})).await?;
    ok(&alice, &contract, "set_group_retention", json!({"group_id": "seed-group", "retention_days": 30})).await?;
    // a joinable group with a public view
    ok(&alice, &contract, "register_group", json!({"group_id": "open-event", "joinable": true})).await?;
    ok(&alice, &contract, "record_transaction", json!({"group_id": "open-event", "user_id": alice.id(),
        "file_hash": "cc".repeat(32), "ipfs_hash": "nova-sdk.near/fastfs.near/x/2", "backend": "FastFS"})).await?;
    // a group whose member was revoked under the old code
    ok(&alice, &contract, "register_group", json!({"group_id": "revoked-group"})).await?;
    ok(&alice, &contract, "add_group_member", json!({"group_id": "revoked-group", "user_id": agent.id()})).await?;
    ok(&agent, &contract, "record_transaction", json!({"group_id": "revoked-group", "user_id": agent.id(),
        "file_hash": "dd".repeat(32), "ipfs_hash": "nova-sdk.near/fastfs.near/x/3", "backend": "FastFS"})).await?;
    ok(&alice, &contract, "revoke_group_member", json!({"group_id": "revoked-group", "user_id": agent.id()})).await?;

    // 3. snapshot under the old code
    let before = snapshot(&contract, &owner, &alice, &agent).await?;
    // the new view does not exist yet
    assert!(call(&owner, &contract, "get_group_members_of",
        json!({"group_id": "seed-group", "account_id": agent.id()})).await?.is_failure(),
        "get_group_members_of must not exist on v0.3.7");

    // 4. code-only upgrade (no migrate)
    let contract = owner.deploy(&new_wasm).await?.into_result()?;

    // 5a. state intact
    let after = snapshot(&contract, &owner, &alice, &agent).await?;
    assert_eq!(before, after, "a read path changed across the upgrade");
    println!("✅ {} read paths identical after the code-only upgrade",
        before.as_object().map(|m| m.len()).unwrap_or(0));

    // 5b. get_group_members_of matches the signed view, for a member and for the group owner
    for g in ["seed-group", "open-event"] {
        let who = if g == "seed-group" { &agent } else { &alice };
        let members = ok(&owner, &contract, "get_group_members_of",
            json!({"group_id": g, "account_id": who.id()})).await?;
        assert_eq!(members, before[format!("{g}/members").as_str()], "{g}: _of must equal the signed view");
    }
    let revoked_members = ok(&owner, &contract, "get_group_members_of",
        json!({"group_id": "revoked-group", "account_id": alice.id()})).await?;
    assert_eq!(revoked_members, json!([alice.id()]), "revoked agent must be gone from the list");
    println!("✅ get_group_members_of returns the same members as the signed view");

    // 5c. refusals, each by its own message
    refused(&agent, &contract, "get_group_members_of",
        json!({"group_id": "seed-group", "account_id": agent.id()}), "reader-gated view (owner only)").await?;
    refused(&alice, &contract, "get_group_members_of",
        json!({"group_id": "seed-group", "account_id": alice.id()}), "reader-gated view (owner only)").await?;
    refused(&mallory, &contract, "get_group_members_of",
        json!({"group_id": "no-such-group", "account_id": mallory.id()}), "reader-gated view (owner only)").await?;
    refused(&owner, &contract, "get_group_members_of",
        json!({"group_id": "seed-group", "account_id": mallory.id()}), "not a member").await?;
    refused(&owner, &contract, "get_group_members_of",
        json!({"group_id": "revoked-group", "account_id": agent.id()}), "not a member").await?;
    refused(&owner, &contract, "get_group_members_of",
        json!({"group_id": "no-such-group", "account_id": agent.id()}), "Group not found").await?;
    println!("✅ get_group_members_of: reader-only (gate before lookup), members-only, revocation honoured");

    // 5d. v0.3.7 behaviour unchanged (regression)
    refused(&mallory, &contract, "register_group", json!({"group_id": format!("member:{}", alice.id())}), "Invalid group_id").await?;
    refused(&mallory, &contract, "record_transaction", json!({"group_id": "seed-group", "user_id": alice.id(),
        "file_hash": "ee".repeat(32), "ipfs_hash": "forged", "backend": "FastFS"}), "uploader must be the caller").await?;
    refused(&owner, &contract, "get_transactions_for_group_of",
        json!({"group_id": "revoked-group", "account_id": agent.id()}), "not a member").await?;
    println!("✅ v0.3.7 checks still enforced");

    // 5e. migrate() is harmless if ever called (identity read of the same layout)
    contract.call("migrate").gas(Gas::from_tgas(300)).transact().await?.into_result()?;
    assert_eq!(view(&contract, "get_group_owner", json!({"group_id": "seed-group"})).await?, json!(alice.id()));
    println!("✅ migrate() on the current layout is a no-op");
    Ok(())
}
// v0.3.7a unit tests. Every test that matters reloads state between calls
// (state_write + drop + state_read), so collisions in storage prefixes show up
// exactly as they would across separate on-chain transactions.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn owner() -> AccountId { "nova-sdk.near".parse().unwrap() }
fn bob() -> AccountId { "bob.near".parse().unwrap() }
fn mallory() -> AccountId { "mallory.near".parse().unwrap() }
fn agent() -> AccountId {
    // Agent Connect wallets are 64-hex implicit accounts.
    "5a5d96f384a41ba3d1c90399dcd563ed6f52c34aa28ba5f200902a655d8ab288".parse().unwrap()
}

fn ctx(predecessor: AccountId) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_near(1))
        .block_timestamp(1_800_000_000_000_000_000);
    testing_env!(b.build());
}

fn fresh() -> Contract {
    ctx(owner());
    Contract::new(owner(), owner(), owner())
}

/// Persist, drop (flushes every store collection), read back.
fn reload(c: Contract) -> Contract {
    env::state_write(&c);
    drop(c);
    env::state_read::<Contract>().expect("state")
}

fn member_groups_of(c: &Contract, who: AccountId) -> Vec<String> {
    ctx(owner());
    c.get_member_groups_of(who)
}

// ── group-id validation ────────────────────────────────────────────────────

#[test]
fn valid_group_ids_are_accepted() {
    let long = "a".repeat(64);
    let ids = ["a", "ironclaw-hackathon-260618", "engine-test-evt", "Acme_Proofs.v2", long.as_str()];
    let mut c = fresh();
    for id in ids {
        ctx(bob());
        c.register_group(id.to_string(), None);
        c = reload(c);
        assert!(c.group_contains_key(id.to_string()), "{id} should exist");
    }
}

#[test]
fn invalid_group_ids_are_rejected() {
    let too_long = "a".repeat(65);
    let bad = ["", too_long.as_str(), "a:b", "a b", "a/b", "é", "member:bob.near", "owned:bob.near", "group_tx:g1"];
    for id in bad {
        let mut c = fresh();
        ctx(mallory());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.register_group(id.to_string(), None);
        }));
        assert!(r.is_err(), "{id:?} must be rejected");
    }
}

/// The live bug: a group named after another account's internal list prefix
/// overwrote that list. With validation the attack is refused and Bob's
/// member list survives a reload untouched.
#[test]
fn collision_attack_cannot_corrupt_member_list() {
    let mut c = fresh();
    ctx(bob());
    c.register_group("g1".to_string(), None);
    c = reload(c);
    assert_eq!(member_groups_of(&c, bob()), vec!["g1".to_string()]);

    ctx(mallory());
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_group(format!("member:{}", bob()), None);
    }));
    c = reload(c);
    assert_eq!(member_groups_of(&c, bob()), vec!["g1".to_string()], "Bob's list was corrupted");
}

#[test]
fn collision_attack_cannot_corrupt_file_index() {
    let mut c = fresh();
    ctx(bob());
    c.register_group("g1".to_string(), None);
    c = reload(c);
    ctx(bob());
    c.record_transaction("g1".into(), bob(), "ab".repeat(32), "loc/1".into(), Some(StorageBackend::FastFS));
    c = reload(c);

    ctx(mallory());
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.register_group("group_tx:g1".to_string(), None);
    }));
    c = reload(c);
    ctx(owner());
    let rows = c.get_transactions_for_group_of("g1".into(), bob());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["user_id"], "bob.near");
}

// ── get_transactions_for_group_of (reader-gated member read path) ─────────

fn group_with_member_file() -> Contract {
    let mut c = fresh();
    ctx(bob());
    c.register_group("payer-acme".into(), None);
    c = reload(c);
    ctx(bob());
    c.add_group_member("payer-acme".into(), agent());
    c = reload(c);
    ctx(bob());
    c.record_transaction("payer-acme".into(), bob(), "cd".repeat(32), "fastfs/loc".into(), Some(StorageBackend::FastFS));
    reload(c)
}

#[test]
fn of_view_returns_enriched_rows_for_a_member() {
    let c = group_with_member_file();
    ctx(owner());
    let rows = c.get_transactions_for_group_of("payer-acme".into(), agent());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["file_hash"], "cd".repeat(32));
    assert_eq!(rows[0]["backend"], "FastFS");
    assert!(rows[0]["timestamp"].is_string());
    assert!(rows[0]["deleted"].is_null());
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn of_view_refuses_a_non_member_account() {
    let c = group_with_member_file();
    ctx(owner());
    c.get_transactions_for_group_of("payer-acme".into(), mallory());
}

#[test]
#[should_panic(expected = "reader-gated")]
fn of_view_refuses_any_caller_but_the_reader() {
    let c = group_with_member_file();
    ctx(agent()); // even a member cannot call it directly
    c.get_transactions_for_group_of("payer-acme".into(), agent());
}

#[test]
#[should_panic(expected = "Group not found")]
fn of_view_unknown_group() {
    let c = fresh();
    ctx(owner());
    c.get_transactions_for_group_of("nope".into(), agent());
}

#[test]
fn of_view_after_revocation_refuses() {
    let mut c = group_with_member_file();
    ctx(bob());
    c.revoke_group_member("payer-acme".into(), agent());
    c = reload(c);
    ctx(owner());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.get_transactions_for_group_of("payer-acme".into(), agent());
    }));
    assert!(r.is_err(), "revoked member must be refused");
}

// ── migrate (current 17-field layout, identity) ───────────────────────────

#[test]
fn migrate_preserves_state() {
    let c = group_with_member_file();
    env::state_write(&c);
    drop(c);
    ctx(owner());
    let m = Contract::migrate();
    let m = reload(m);
    ctx(owner());
    assert_eq!(m.get_group_owner("payer-acme".into()), bob());
    assert!(m.is_authorized("payer-acme".into(), agent()));
    assert_eq!(m.get_transactions_for_group_of("payer-acme".into(), agent()).len(), 1);
    assert_eq!(m.estimate_fee("register_group".into()), 50_000_000_000_000_000_000_000);
}

// ── record_transaction: uploader must be the caller (or NOVA's operator) ──

#[test]
#[should_panic(expected = "uploader must be the caller")]
fn record_refuses_forged_uploader() {
    let mut c = fresh();
    ctx(bob());
    c.register_group("g1".into(), None);
    c = reload(c);
    ctx(mallory()); // not bob, not a member, names bob as uploader
    c.record_transaction("g1".into(), bob(), "ef".repeat(32), "fake/loc".into(), Some(StorageBackend::FastFS));
}

#[test]
fn record_by_member_for_self_is_accepted() {
    let c = group_with_member_file(); // bob recorded his own upload
    ctx(owner());
    assert_eq!(c.get_transactions_for_group_of("payer-acme".into(), bob()).len(), 1);
}

#[test]
fn record_relayed_by_operator_for_a_member() {
    let mut c = group_with_member_file();
    ctx(owner()); // NOVA relays an upload by the agent (a member without a custodial key)
    c.record_transaction("payer-acme".into(), agent(), "12".repeat(32), "fastfs/agent".into(), Some(StorageBackend::FastFS));
    c = reload(c);
    ctx(owner());
    let rows = c.get_transactions_for_group_of("payer-acme".into(), agent());
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["user_id"], agent().to_string());
}

#[test]
#[should_panic(expected = "User not authorized")]
fn operator_cannot_record_for_a_non_member() {
    let mut c = group_with_member_file();
    ctx(owner());
    c.record_transaction("payer-acme".into(), mallory(), "34".repeat(32), "x".into(), Some(StorageBackend::FastFS));
}
// v0.3.8 unit tests: get_group_members_of (reader-gated member list).
// Same conventions as v037.rs: reload between calls; each refusal asserted by
// its full message (both gates start with "Unauthorized").

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn owner() -> AccountId { "nova-sdk.near".parse().unwrap() }
fn bob() -> AccountId { "bob.near".parse().unwrap() }
fn mallory() -> AccountId { "mallory.near".parse().unwrap() }
fn agent() -> AccountId {
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

fn reload(c: Contract) -> Contract {
    env::state_write(&c);
    drop(c);
    env::state_read::<Contract>().expect("state")
}

/// bob (a wallet owner) owns a private group; the agent is a member.
fn private_group_with_agent() -> Contract {
    let mut c = fresh();
    ctx(bob());
    c.register_group("payer-acme".into(), None);
    c = reload(c);
    ctx(bob());
    c.add_group_member("payer-acme".into(), agent());
    reload(c)
}

// ── happy path ────────────────────────────────────────────────────────────

#[test]
fn members_of_returns_the_list_for_a_member() {
    let mut c = private_group_with_agent();
    ctx(owner());
    let via_reader = c.get_group_members_of("payer-acme".into(), agent());
    assert_eq!(via_reader, vec![bob(), agent()]);

    // Parity with the signed (fee-collecting) method for the same group.
    ctx(bob());
    let via_signed = c.get_group_members("payer-acme".into());
    assert_eq!(via_reader, via_signed);
}

#[test]
fn members_of_works_for_the_group_owner_account() {
    let c = private_group_with_agent();
    ctx(owner());
    assert_eq!(c.get_group_members_of("payer-acme".into(), bob()), vec![bob(), agent()]);
}

// ── security invariant: only the reader identity may call ─────────────────

#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn members_of_refuses_a_member_calling_directly() {
    let c = private_group_with_agent();
    ctx(agent());
    c.get_group_members_of("payer-acme".into(), agent());
}

#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn members_of_refuses_the_group_owner_calling_directly() {
    let c = private_group_with_agent();
    ctx(bob());
    c.get_group_members_of("payer-acme".into(), bob());
}

/// The gate runs before the group lookup, so a stranger can't use the
/// "Group not found" error to learn which group ids exist.
#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn members_of_gate_runs_before_group_lookup() {
    let c = fresh();
    ctx(mallory());
    c.get_group_members_of("nope".into(), mallory());
}

// ── refusals for the reader ───────────────────────────────────────────────

#[test]
#[should_panic(expected = "Unauthorized: not a member")]
fn members_of_refuses_a_non_member_account() {
    let c = private_group_with_agent();
    ctx(owner());
    c.get_group_members_of("payer-acme".into(), mallory());
}

#[test]
#[should_panic(expected = "Group not found")]
fn members_of_unknown_group() {
    let c = fresh();
    ctx(owner());
    c.get_group_members_of("nope".into(), agent());
}

#[test]
#[should_panic(expected = "Unauthorized: not a member")]
fn members_of_refuses_after_revocation() {
    let mut c = private_group_with_agent();
    ctx(bob());
    c.revoke_group_member("payer-acme".into(), agent());
    c = reload(c);
    ctx(owner());
    c.get_group_members_of("payer-acme".into(), agent());
}

// ── gate binds the immediate caller, not the transaction signer ───────────

/// A contract (mallory) relays the call inside a transaction originally signed by
/// the reader. The gate must look at the predecessor (mallory) and refuse.
#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn members_of_refuses_a_relaying_contract_even_if_reader_signed() {
    let c = private_group_with_agent();
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(mallory())
        .signer_account_id(owner())
        .block_timestamp(1_800_000_000_000_000_000);
    testing_env!(b.build());
    c.get_group_members_of("payer-acme".into(), mallory());
}
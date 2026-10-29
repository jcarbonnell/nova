// v0.3.9 unit tests: bounded write inputs (storage-drain fix) + signer-vs-predecessor
// tests for the three remaining reader-gated views.
// Same conventions as v037.rs / v038.rs: reload between calls; each refusal asserted
// by its full message.
//
// The STORAGE section measures the worst case each write can add (maximum lengths
// everywhere) and prints it in bytes and NEAR. Those numbers set the post-deploy fees
// (set_fee): every write must pay at least what it can lock.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn owner() -> AccountId { "nova-sdk.near".parse().unwrap() }
fn bob() -> AccountId { "bob.near".parse().unwrap() }
fn mallory() -> AccountId { "mallory.near".parse().unwrap() }
/// Longest possible NEAR account id (64 chars): the worst case for every stored id.
fn long_account(c: char) -> AccountId { c.to_string().repeat(64).parse().unwrap() }

const T0: u64 = 1_800_000_000_000_000_000;
const STORAGE_BYTE_YOCTO: u128 = 10_000_000_000_000_000_000; // 1e19 yocto per byte (NEAR protocol)

fn ctx_dep(predecessor: AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .block_timestamp(T0);
    testing_env!(b.build());
}
fn ctx(predecessor: AccountId) { ctx_dep(predecessor, NearToken::from_near(1)); }

fn fresh() -> Contract {
    ctx(owner());
    Contract::new(owner(), owner(), owner())
}
fn reload(c: Contract) -> Contract {
    env::state_write(&c);
    drop(c);
    env::state_read::<Contract>().expect("state")
}

const HASH: &str = "f6837f2927abadd802fcd0741ff08640a40a60f4450cde1d6a273f200eacb65e";
const LOC: &str = "nova-sdk.near/fastfs.near/8641e048d973ef5c83d1a0088f93638eb5c3f86746ee2d34c4b5cb0430083c5d/6e4b975e-8f98-48c3-bc39-edcd4fc7c500";

/// bob owns "g"; bob is its only member.
fn with_group() -> Contract {
    let mut c = fresh();
    ctx(bob());
    c.register_group("g".into(), None);
    reload(c)
}

fn record(c: &mut Contract, who: AccountId, file_hash: &str, loc: &str) -> String {
    ctx(who.clone());
    c.record_transaction("g".into(), who, file_hash.into(), loc.into(), Some(StorageBackend::FastFS))
}

// ── record_transaction: accepted inputs ────────────────────────────────────────

#[test]
fn record_accepts_a_real_fastfs_upload() {
    let mut c = with_group();
    let id = record(&mut c, bob(), HASH, LOC);
    let c = reload(c);
    assert!(c.transactions.contains_key(&id));
}

#[test]
fn record_accepts_uppercase_hex_and_a_160_byte_location() {
    // MCP's check is case-insensitive: an uppercase hash must keep working.
    let mut c = with_group();
    record(&mut c, bob(), &HASH.to_uppercase(), &"L".repeat(MAX_LOCATION_BYTES));
}

#[test]
fn record_accepts_a_legacy_cid() {
    let mut c = with_group();
    ctx(bob());
    c.record_transaction("g".into(), bob(), HASH.into(), "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG".into(), None);
}

// ── record_transaction: refusals (the drain) ───────────────────────────────────

#[test]
#[should_panic(expected = "Invalid file_hash: expected 64 hex characters (SHA-256)")]
fn record_refuses_a_megabyte_file_hash() {
    let mut c = with_group();
    record(&mut c, bob(), &"a".repeat(1_000_000), LOC);
}

#[test]
#[should_panic(expected = "Invalid ipfs_hash: expected 1-160 bytes")]
fn record_refuses_a_megabyte_location() {
    let mut c = with_group();
    record(&mut c, bob(), HASH, &"x".repeat(1_000_000));
}

#[test]
#[should_panic(expected = "Invalid ipfs_hash: expected 1-160 bytes")]
fn record_refuses_a_161_byte_location() {
    let mut c = with_group();
    record(&mut c, bob(), HASH, &"x".repeat(MAX_LOCATION_BYTES + 1));
}

#[test]
#[should_panic(expected = "Invalid ipfs_hash: expected 1-160 bytes")]
fn record_refuses_an_empty_location() {
    let mut c = with_group();
    record(&mut c, bob(), HASH, "");
}

#[test]
#[should_panic(expected = "Invalid file_hash: expected 64 hex characters (SHA-256)")]
fn record_refuses_63_hex() {
    let mut c = with_group();
    record(&mut c, bob(), &HASH[..63], LOC);
}

#[test]
#[should_panic(expected = "Invalid file_hash: expected 64 hex characters (SHA-256)")]
fn record_refuses_65_hex() {
    let mut c = with_group();
    record(&mut c, bob(), &format!("{HASH}0"), LOC);
}

#[test]
#[should_panic(expected = "Invalid file_hash: expected 64 hex characters (SHA-256)")]
fn record_refuses_64_non_hex() {
    let mut c = with_group();
    record(&mut c, bob(), &"g".repeat(64), LOC);
}

#[test]
#[should_panic(expected = "Invalid file_hash: expected 64 hex characters (SHA-256)")]
fn record_refuses_an_empty_file_hash() {
    let mut c = with_group();
    record(&mut c, bob(), "", LOC);
}

/// The bound is checked before the fee and before membership: an oversized call
/// is refused for its size, whatever else is wrong with it.
#[test]
#[should_panic(expected = "Invalid ipfs_hash: expected 1-160 bytes")]
fn record_bound_runs_before_fee_and_membership() {
    let mut c = with_group();
    ctx_dep(mallory(), NearToken::from_yoctonear(0)); // not a member, no fee
    c.record_transaction("g".into(), mallory(), HASH.into(), "x".repeat(MAX_LOCATION_BYTES + 1), None);
}

// ── v0.3.7 rules unchanged ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Unauthorized: uploader must be the caller")]
fn record_still_refuses_forged_attribution() {
    let mut c = with_group();
    ctx(mallory());
    c.record_transaction("g".into(), bob(), HASH.into(), LOC.into(), Some(StorageBackend::FastFS));
}

#[test]
#[should_panic(expected = "User not authorized")]
fn record_still_refuses_a_non_member() {
    let mut c = with_group();
    record(&mut c, mallory(), HASH, LOC);
}

// ── update_checksum / claim_token bounds ───────────────────────────────────────

#[test]
fn checksum_accepts_32_bytes_hex() {
    let mut c = with_group();
    ctx(bob());
    c.update_checksum("g".into(), "ab".repeat(32));
    let c = reload(c);
    assert_eq!(c.get_group_checksum("g".into()), Some("ab".repeat(32)));
}

#[test]
#[should_panic(expected = "Invalid checksum: expected 1-64 hex characters")]
fn checksum_refuses_more_than_32_bytes() {
    let mut c = with_group();
    ctx(bob());
    c.update_checksum("g".into(), "ab".repeat(500_000));
}

#[test]
#[should_panic(expected = "Invalid checksum: expected 1-64 hex characters")]
fn checksum_refuses_empty() {
    let mut c = with_group();
    ctx(bob());
    c.update_checksum("g".into(), String::new());
}

#[test]
#[should_panic(expected = "Invalid nonce: at most 64 bytes")]
fn claim_token_refuses_a_long_nonce() {
    let c0 = with_group();
    let mut c = c0;
    ctx(bob());
    let payload = near_sdk::serde_json::json!({
        "group_id": "g", "user_id": bob().to_string(), "nonce": "n".repeat(10_000), "timestamp": T0,
    }).to_string();
    let b64 = BASE64_STANDARD.encode(payload.as_bytes());
    c.claim_token("g".into(), b64, hex::encode([1u8; 64])); // refused before the signature check
}

// ── signer vs predecessor: the remaining reader-gated views ────────────────────
// A contract (mallory) relays the call inside a transaction signed by the reader.
// Every gate must read the predecessor and refuse.

fn relayed() {
    let mut b = VMContextBuilder::new();
    b.current_account_id(owner())
        .predecessor_account_id(mallory())
        .signer_account_id(owner())
        .block_timestamp(T0);
    testing_env!(b.build());
}

#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn owned_groups_of_refuses_a_relaying_contract() {
    let c = with_group();
    relayed();
    c.get_owned_groups_of(bob());
}

#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn member_groups_of_refuses_a_relaying_contract() {
    let c = with_group();
    relayed();
    c.get_member_groups_of(bob());
}

#[test]
#[should_panic(expected = "Unauthorized: reader-gated view (owner only)")]
fn transactions_of_refuses_a_relaying_contract() {
    let c = with_group();
    relayed();
    c.get_transactions_for_group_of("g".into(), bob());
}

// ── STORAGE: worst case each write can add ─────────────────────────────────────

fn near(bytes: u64) -> f64 { (bytes as u128 * STORAGE_BYTE_YOCTO) as f64 / 1e24 }

/// Storage `f` adds, measured inside ONE context (testing_env! resets storage_usage
/// to the builder default, so the context is set first and `f` must not reset it).
fn delta(c: Contract, who: AccountId, f: impl FnOnce(&mut Contract)) -> (Contract, u64) {
    ctx(who);
    let mut c = reload(c);
    let before = env::storage_usage();
    f(&mut c);
    let c = reload(c);
    let after = env::storage_usage();
    (c, after.saturating_sub(before))
}

#[test]
fn storage_worst_case_per_write_is_bounded() {
    let gid = "G".repeat(64);                 // longest group id
    let big_owner = long_account('o');        // longest account ids
    let big_member = long_account('m');
    let big_joiner = long_account('j');

    let c = fresh();
    let (c, reg) = delta(c, big_owner.clone(), |c| c.register_group(gid.clone(), Some(true)));
    let (c, add) = delta(c, big_owner.clone(), |c| c.add_group_member(gid.clone(), big_member.clone()));
    let (c, rec) = delta(c, big_member.clone(), |c| {
        c.record_transaction(gid.clone(), big_member.clone(), "a".repeat(64), "L".repeat(MAX_LOCATION_BYTES),
            Some(StorageBackend::FastFS));
    });
    let (c, chk) = delta(c, big_owner.clone(), |c| c.update_checksum(gid.clone(), "ab".repeat(32)));
    let (c, open) = delta(c, big_owner.clone(),
        |c| c.open_hackathon_join(gid.clone(), U64(T0 + 1_000_000_000_000), Some(10)));
    let (_c, join) = delta(c, big_joiner.clone(), |c| c.join_group(gid.clone()));

    println!("\nv0.3.9 worst-case storage per write (64-char ids, 160-byte location; 1e19 yocto/byte):");
    for (name, b) in [("register_group", reg), ("add_group_member", add), ("record_transaction", rec),
                      ("update_checksum", chk), ("open_hackathon_join", open), ("join_group", join)] {
        println!("  {name:<20} {b:>5} bytes = {:.6} NEAR", near(b));
    }

    // The point of v0.3.9: no single write can add more than a small, known amount.
    // (v0.3.8 had no bound: one record could add ~4 MB = ~40 NEAR.)
    assert!(rec > 0 && rec <= 1_000, "record_transaction worst case {rec} bytes");
    assert!(add > 0 && add <= 600, "add_group_member worst case {add} bytes");
    assert!(join > 0 && join <= 600, "join_group worst case {join} bytes");
    assert!(chk > 0 && chk <= 200, "update_checksum worst case {chk} bytes");
}

// ── register_shade_worker: no longer open to anyone ────────────────────────────

fn with_code_hash() -> Contract {
    let mut c = fresh();
    ctx(owner());
    c.approve_shade_code_hash("h".repeat(64));
    reload(c)
}

#[test]
#[should_panic(expected = "Only owner or Shade contract can register workers")]
fn worker_registration_refuses_a_stranger() {
    let mut c = with_code_hash();
    ctx(mallory());
    c.register_shade_worker(long_account('w'), vec![0u8; 64]);
}

#[test]
fn worker_registration_allowed_for_owner() {
    let mut c = with_code_hash();
    ctx(owner());
    c.register_shade_worker("worker.near".parse().unwrap(), vec![0u8; 64]);
    let c = reload(c);
    assert!(c.workers.contains_key(&"worker.near".parse::<AccountId>().unwrap()));
}

// ── claim_token: worst-case storage of one used nonce ──────────────────────────

#[test]
fn storage_claim_token_worst_case_is_bounded() {
    use near_crypto::{KeyType, SecretKey, Signature};
    let gid = "G".repeat(64);
    let member = long_account('m');
    let mut c = fresh();
    ctx(owner());
    c.register_group(gid.clone(), None);
    c.add_group_member(gid.clone(), member.clone());
    let c = reload(c);

    let sk = SecretKey::from_seed(KeyType::ED25519, "v039");
    let pk: near_sdk::PublicKey = sk.public_key().to_string().parse().unwrap();
    let payload = near_sdk::serde_json::json!({
        "group_id": gid, "user_id": member.to_string(), "nonce": "n".repeat(MAX_NONCE_BYTES), "timestamp": T0,
    }).to_string();
    let sig = match sk.sign(payload.as_bytes()) { Signature::ED25519(s) => hex::encode(s.to_bytes()), _ => unreachable!() };

    let mut b = VMContextBuilder::new();
    b.current_account_id(owner()).predecessor_account_id(member.clone()).signer_account_id(member.clone())
        .signer_account_pk(pk).attached_deposit(NearToken::from_near(1)).block_timestamp(T0);
    testing_env!(b.build());
    let mut c = reload(c);
    let before = env::storage_usage();
    c.claim_token(gid.clone(), BASE64_STANDARD.encode(payload.as_bytes()), sig);
    let _c = reload(c);
    let used = env::storage_usage().saturating_sub(before);
    println!("  claim_token          {used:>5} bytes = {:.6} NEAR (64-byte nonce, 64-char ids)", near(used));
    assert!(used > 0 && used <= 400, "claim_token worst case {used} bytes");
}

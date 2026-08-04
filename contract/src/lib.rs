// NOVA contract v0.3.4 - per-file keys + tombstone transactions + hackathon join
use near_sdk::{env, log, near, AccountId, BorshStorageKey, PanicOnDefault, Promise};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::{LookupMap, Vector as StoreVec, IterableMap};
use near_sdk::serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use near_sdk::serde_json;
use near_sdk::NearToken;
use near_sdk::json_types::U64;
use hex;
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as BASE64_STANDARD};
use std::str::FromStr;

// Define the contract structure
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    shade_contract_id: AccountId,
    fee_recipient: AccountId,
    fees: LookupMap<String, u128>,
    groups: LookupMap<String, Group>,
    group_members: LookupMap<String, StoreVec<AccountId>>,
    transactions: IterableMap<String, Transaction>,
    shade_code_hash: Option<String>,
    workers: LookupMap<AccountId, String>,
    used_nonces: LookupMap<String, bool>,
    owned_groups: LookupMap<AccountId, StoreVec<String>>,
    member_groups: LookupMap<AccountId, StoreVec<String>>,
    group_transactions: LookupMap<String, StoreVec<String>>,
    joinable_groups: LookupMap<String, bool>,
    join_windows: LookupMap<String, JoinWindow>,
    // per-transaction metadata (backend, upload timestamp, deletion
    // tombstone). Parallel map keyed by trans_id, NOT fields on Transaction:
    // Transaction is stored inside IterableMap, so changing it would brick every
    // existing transaction's borsh bytes (§10). Absent ⇒ legacy IPFS, not deleted.
    tx_meta: LookupMap<String, TxMeta>,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Group {
    owner: AccountId,
    shade_checksum: Option<String>,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct Transaction {
    group_id: String,
    user_id: String,
    file_hash: String,
    // Historically the IPFS CID; since §5.5 it holds the storage LOCATION for any
    // backend (IPFS CID or FastFS ref). Name kept for borsh + JSON compatibility
    // with existing consumers; `backend` in TxMeta disambiguates interpretation.
    ipfs_hash: String,
}

// §5.5 storage backends. Ipfs = legacy only (no new IPFS uploads, §5.2).
// APPEND-ONLY: never reorder/remove variants — the borsh discriminant is stored
// inside TxMeta and reordering would misread existing values (§10).
#[derive(BorshDeserialize, BorshSerialize, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub enum StorageBackend { FastFS, Ipfs }

// §5.5 deletion reasons. APPEND-ONLY (see StorageBackend).
#[derive(BorshDeserialize, BorshSerialize, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub enum DeletionReason { MemberRevocation, OwnerRequest, RetentionPolicy, ComplianceRequest }

// Stored deletion record (borsh). u64 timestamp; the view exposes it as a string.
#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct DeletionRecord {
    deleted_at: u64,
    deleted_by: AccountId,
    reason: DeletionReason,
}

// Stored per-transaction metadata (borsh), keyed by trans_id in tx_meta.
// Absent ⇒ legacy IPFS, upload time unknown, not deleted.
#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct TxMeta {
    backend: StorageBackend,
    timestamp: u64,
    deleted: Option<DeletionRecord>,
}

// JSON views (u64 → string, NEAR convention — avoids JS 2^53 precision loss).
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct DeletionRecordView {
    pub deleted_at: String,
    pub deleted_by: String,
    pub reason: DeletionReason,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct TxMetaView {
    pub backend: StorageBackend,
    pub timestamp: String,
    pub deleted: Option<DeletionRecordView>,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct JoinWindow {
    expires_at: u64,
    max_uses: Option<u32>,
    uses: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct JoinWindowView {
    pub expires_at: String,
    pub max_uses: Option<u32>,
    pub uses: u32,
    pub open: bool,
}

#[derive(BorshStorageKey, BorshSerialize)]
enum StorageKey {
    Groups,
    GroupMembers,
    Transactions,
    Workers,
    UsedNonces,
    Fees,
    OwnedGroups,
    MemberGroups,
    GroupTransactions,
    JoinableGroups,
    JoinWindows,
    TxMeta,
}

#[derive(Serialize)]
#[serde(tag = "event_type", content = "data")]
enum NovaEvent {
    Registered { group_id: String, owner: AccountId },
    Revoked { group_id: String, user_id: AccountId, owner: AccountId },
    FeeCollected { action: String, fee: u128 },
}

// Implement the contract structure
#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, shade_contract_id: AccountId, fee_recipient: AccountId) -> Self {
        let mut fees = LookupMap::new(StorageKey::Fees);
        // Default fees (in yoctoNEAR) adjustable by owner later
        fees.insert("register_group".to_string(), 50_000_000_000_000_000_000_000u128);  // 0.05 NEAR
        fees.insert("add_group_member".to_string(), 1_000_000_000_000_000_000u128);     // 0.001 NEAR
        fees.insert("revoke_group_member".to_string(), 1_000_000_000_000_000_000u128); // 0.001 NEAR
        fees.insert("record_transaction".to_string(), 2_000_000_000_000_000_000u128);  // 0.002 NEAR
        fees.insert("update_checksum".to_string(), 100_000_000_000_000_000u128);       // 0.0001 NEAR
        fees.insert("approve_shade_code_hash".to_string(), 100_000_000_000_000_000u128); // 0.0001 NEAR
        fees.insert("claim_token".to_string(), 1_000_000_000_000_000_000u128);         // 0.001 NEAR
        fees.insert("get_owned_groups".to_string(), 100_000_000_000_000_000u128);  // 0.0001 NEAR
        fees.insert("get_member_groups".to_string(), 100_000_000_000_000_000u128);  // 0.0001 NEAR
        fees.insert("get_group_members".to_string(), 100_000_000_000_000_000u128);  // 0.0001 NEAR
        fees.insert("get_transactions_for_group".to_string(), 100_000_000_000_000_000u128);  // 0.0001 NEAR

        Self {
            owner,
            shade_contract_id,
            fee_recipient,
            fees,
            groups: LookupMap::new(StorageKey::Groups),
            group_members: LookupMap::new(StorageKey::GroupMembers),
            transactions: IterableMap::new(StorageKey::Transactions),
            shade_code_hash: None,
            workers: LookupMap::new(StorageKey::Workers),
            used_nonces: LookupMap::new(StorageKey::UsedNonces),
            owned_groups: LookupMap::new(StorageKey::OwnedGroups),
            member_groups: LookupMap::new(StorageKey::MemberGroups),
            group_transactions: LookupMap::new(StorageKey::GroupTransactions),
            joinable_groups: LookupMap::new(StorageKey::JoinableGroups),
            join_windows: LookupMap::new(StorageKey::JoinWindows),
            tx_meta: LookupMap::new(StorageKey::TxMeta),
        }
    }

    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        // CURRENT deployed state = v0.3.3, the 15 fields below (owner … join_windows),
        // in this exact order and types. This upgrade adds ONE field (tx_meta), so the
        // top-level borsh layout changes → migrate is REQUIRED (§10). tx_meta starts
        // empty; Transaction is UNCHANGED, so every existing transaction still
        // deserializes — no O(N) rewrite, no brick. joinable_groups/join_windows are
        // PRESERVED from old state (the previous migrate re-initialised them because
        // they were new THEN; here they already hold data — e.g. engine-test-evt — and
        // must carry over, not be wiped).
        #[derive(near_sdk::borsh::BorshDeserialize)]
        #[borsh(crate = "near_sdk::borsh")]
        struct OldContract {
            owner: AccountId,
            shade_contract_id: AccountId,
            fee_recipient: AccountId,
            fees: LookupMap<String, u128>,
            groups: LookupMap<String, Group>,
            group_members: LookupMap<String, StoreVec<AccountId>>,
            transactions: IterableMap<String, Transaction>,
            shade_code_hash: Option<String>,
            workers: LookupMap<AccountId, String>,
            used_nonces: LookupMap<String, bool>,
            owned_groups: LookupMap<AccountId, StoreVec<String>>,
            member_groups: LookupMap<AccountId, StoreVec<String>>,
            group_transactions: LookupMap<String, StoreVec<String>>,
            joinable_groups: LookupMap<String, bool>,
            join_windows: LookupMap<String, JoinWindow>,
        }

        let old: OldContract = env::state_read().expect("failed to read old state");

        Self {
            owner: old.owner,
            shade_contract_id: old.shade_contract_id,
            fee_recipient: old.fee_recipient,
            fees: old.fees,
            groups: old.groups,
            group_members: old.group_members,
            transactions: old.transactions,
            shade_code_hash: old.shade_code_hash,
            workers: old.workers,
            used_nonces: old.used_nonces,
            owned_groups: old.owned_groups,
            member_groups: old.member_groups,
            group_transactions: old.group_transactions,
            joinable_groups: old.joinable_groups,
            join_windows: old.join_windows,
            tx_meta: LookupMap::new(StorageKey::TxMeta),
        }
    }

    // Owner-only method to update fee recipient
    #[payable]
    pub fn set_fee_recipient(&mut self, new_recipient: AccountId) {
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "Only owner can update recipient");
        self.fee_recipient = new_recipient.clone();
        log!("Fee recipient updated to: {}", new_recipient);
    }
    
    // Owner-only method to update fee per action
    #[payable]
    pub fn set_fee(&mut self, action: String, fee_yocto: String) {
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "Only owner can set fees");
        let fee_yocto = u128::from_str(&fee_yocto).expect("Invalid u128 fee");
        self.fees.insert(action.clone(), fee_yocto);
        log!("Fee set for {}: {} yoctoNEAR", action, fee_yocto);
    }

    // view method: estimate fee for action
    pub fn estimate_fee(&self, action: String) -> u128 {
        *self.fees.get(&action).unwrap_or(&0)
    }

    // Stub for future dynamic fees via Chainlink oracle (e.g., NEAR/USD + IPFS est)
    pub fn get_dynamic_fee(&self, _action: String) -> u128 {
        // TODO: Call Chainlink oracle (e.g., Promise to oracle contract for feed)
        // near_usd_price = oracle::get_feed("NEAR/USD");
        // ipfs_cost = oracle::get_feed("IPFS/GB");
        // return base_fee(action) * near_usd_price + ipfs_cost * file_size_estimate;
        0  // Placeholder
    }

    // Internal fee transfer method
    fn collect_fee(&self, action: &str, attached_deposit: u128) {
        let fee = self.estimate_fee(action.to_string());
        assert!(attached_deposit >= fee, "Attach at least {} yoctoNEAR for fee", fee);
        if fee > 0 {
            Promise::new(self.fee_recipient.clone())
                .transfer(NearToken::from_yoctonear(fee));
            let event = NovaEvent::FeeCollected {
                action: action.to_string(),
                fee,
            };
            let event_log = serde_json::to_string(&event).expect("Failed to serialize event");
            env::log_str(&format!("EVENT_JSON:{}", event_log));
            log!("Fee collected for {}: {} yoctoNEAR to {}", action, fee, self.fee_recipient);
        }
    }

    #[payable]
    pub fn register_group(&mut self, group_id: String, joinable: Option<bool>) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("register_group", attached);

        assert!(!self.groups.contains_key(&group_id), "Group exists");
        let caller = env::predecessor_account_id();
        let group = Group { owner: caller.clone(), shade_checksum: None };
        self.groups.insert(group_id.clone(), group);

        // Record joinability ONCE at creation. Only ever inserted, never mutated,
        // so joinability is immutable for the life of the group. Absence (legacy
        // groups, or joinable None/false) means the group is NOT self-joinable.
        if joinable == Some(true) {
            self.joinable_groups.insert(group_id.clone(), true);
        }
        let mut members = StoreVec::new(group_id.as_bytes());
        members.push(caller.clone());
        self.group_members.insert(group_id.clone(), members);
        log!("Group {} registered by {} (owner added as member; event emitted for Shade key init)", group_id, caller);
        
        // add to owned_groups
        let prefix = format!("owned:{}", caller);
        let mut owned = StoreVec::new(prefix.as_bytes());
        if let Some(existing) = self.owned_groups.get(&caller) {
            for g in existing.iter() {
                owned.push(g.clone());
            }
        }
        owned.push(group_id.clone());
        self.owned_groups.insert(caller.clone(), owned);

        // add to member_groups
        let prefix = format!("member:{}", caller);
        let mut member = StoreVec::new(prefix.as_bytes());
        if let Some(existing) = self.member_groups.get(&caller) {
            for g in existing.iter() {
                member.push(g.clone());
            }
        }
        member.push(group_id.clone());
        self.member_groups.insert(caller.clone(), member);

        // initialize empty group_transactions
        let tx_prefix = format!("group_tx:{}", group_id);
        let transactions = StoreVec::new(tx_prefix.as_bytes());
        self.group_transactions.insert(group_id.clone(), transactions);

        // Emit Event (parseable by indexer → trigger Shade /generate_key)
        let event = NovaEvent::Registered { group_id: group_id.clone(), owner: caller.clone() };
        let event_log = serde_json::to_string(&event).expect("Failed to serialize event");
        env::log_str(&format!("EVENT_JSON:{}", event_log));
    }

    pub fn group_contains_key(&self, group_id: String) -> bool {
        self.groups.contains_key(&group_id)
    }

    pub fn get_group_owner(&self, group_id: String) -> AccountId {
        self.groups.get(&group_id).map_or_else(|| env::panic_str("Group not found"), |g| g.owner.clone())
    }

    // Returns list of groups owned by the user
    #[payable]
    pub fn get_owned_groups(&mut self) -> Vec<String> {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("get_owned_groups", attached);
        
        let caller = env::predecessor_account_id();
        
        self.owned_groups
            .get(&caller)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default()
    }

    // Returns list of groups where the user is a member (includes owned groups)
    #[payable]
    pub fn get_member_groups(&mut self) -> Vec<String> {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("get_member_groups", attached);
        
        let caller = env::predecessor_account_id();
        
        self.member_groups
            .get(&caller)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default()
    }

    #[payable]
    pub fn add_group_member(&mut self, group_id: String, user_id: AccountId) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("add_group_member", attached);
        
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can add");
        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        assert!(!members.iter().any(|x| *x == user_id), "User already a member");
        members.push(user_id.clone());
        log!("Added {} to group {}", user_id, group_id);

        // add to member_groups
        let prefix = format!("member:{}", user_id);
        let mut member_list = StoreVec::new(prefix.as_bytes());
        if let Some(existing) = self.member_groups.get(&user_id) {
            for g in existing.iter() {
                member_list.push(g.clone());
            }
        }
        member_list.push(group_id.clone());
        self.member_groups.insert(user_id.clone(), member_list);
    }

    #[payable]
    pub fn revoke_group_member(&mut self, group_id: String, user_id: AccountId) {
        let attached = env::attached_deposit().as_yoctonear();
        // Contract owner (via shade agent) pays no protocol fee for revocations
        let caller = env::predecessor_account_id();
        if caller != self.owner {
            self.collect_fee("revoke_group_member", attached);
        }
        
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can revoke");
        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        if let Some(pos) = members.iter().position(|x| x == &user_id) {
            members.swap_remove(pos.try_into().unwrap());
            log!("Revoked {} from group {} (rotated key in Shade)", user_id, group_id);

            // remove from member_groups
            if let Some(member_list) = self.member_groups.get_mut(&user_id) {
                if let Some(pos) = member_list.iter().position(|g| g == &group_id) {
                    member_list.swap_remove(pos.try_into().unwrap());
                    // If the member now has no groups, remove the key to reclaim storage
                    if member_list.is_empty() {
                        self.member_groups.remove(&user_id);
                    }
                }
            }

            // Emit Event (indexer → Shade /api/key-management/rotate_key {group_id})
            let event = NovaEvent::Revoked { group_id: group_id.clone(), user_id: user_id.clone(), owner: caller.clone() };
            let event_log = serde_json::to_string(&event).expect("Failed to serialize event");
            env::log_str(&format!("EVENT_JSON:{}", event_log));

        } else {
            env::panic_str("User not a member");
        }
    }

    pub fn is_authorized(&self, group_id: String, user_id: AccountId) -> bool {
        let members = self.group_members.get(&group_id).expect("Group not found");
        members.iter().any(|x| *x == user_id)
    }

    /// Open a self-join window on a group. Group-owner-gated AND only permitted
    /// on groups created with joinable=true. A non-joinable group (every normal
    /// group, including all legacy groups) can NEVER have a window opened.
    #[payable]
    pub fn open_hackathon_join(
        &mut self,
        group_id: String,
        expires_at: U64,
        max_uses: Option<u32>,
    ) {
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can open join");

        assert!(
            *self.joinable_groups.get(&group_id).unwrap_or(&false),
            "Group is not joinable (must be created with joinable=true)"
        );

        let expires = expires_at.0;
        assert!(expires > env::block_timestamp(), "expires_at must be in the future");

        self.join_windows.insert(
            group_id.clone(),
            JoinWindow { expires_at: expires, max_uses, uses: 0 },
        );
        log!("Opened hackathon join window for {} until {}", group_id, expires);
    }

    /// Self-join a group that has an open window. Anyone may call; caller pays
    /// the join fee and is added as a member. This is the ONLY self-service
    /// membership path, and works ONLY on groups with an open window.
    #[payable]
    pub fn join_group(&mut self, group_id: String) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("join_group", attached);

        assert!(self.groups.contains_key(&group_id), "Group not found");

        let window = self.join_windows.get(&group_id).expect("Group not open for join").clone();

        assert!(env::block_timestamp() < window.expires_at, "Join window closed");

        if let Some(cap) = window.max_uses {
            assert!(window.uses < cap, "Join window full");
        }

        let caller = env::predecessor_account_id();
        {
            let members = self.group_members.get(&group_id).expect("Group members not found");
            assert!(!members.iter().any(|x| *x == caller), "Already a member");
        }

        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        members.push(caller.clone());

        // Rebuild member_groups for caller — mirrors add_group_member's bookkeeping EXACTLY.
        let prefix = format!("member:{}", caller);
        let mut member_list = StoreVec::new(prefix.as_bytes());
        if let Some(existing) = self.member_groups.get(&caller) {
            for g in existing.iter() {
                member_list.push(g.clone());
            }
        }
        member_list.push(group_id.clone());
        self.member_groups.insert(caller.clone(), member_list);

        let window_mut = self.join_windows.get_mut(&group_id).expect("Group not open for join");
        window_mut.uses += 1;

        log!("{} self-joined group {} ({}/{:?} uses)", caller, group_id, window_mut.uses, window_mut.max_uses);
    }

    /// Close a join window early or after the deadline. Group-owner-gated, no fee.
    pub fn close_hackathon_join(&mut self, group_id: String) {
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can close join");
        self.join_windows.remove(&group_id);
        log!("Closed hackathon join window for {}", group_id);
    }

    /// Free view: current join-window state, or None if never opened.
    pub fn get_join_window(&self, group_id: String) -> Option<JoinWindowView> {
        self.join_windows.get(&group_id).map(|w| {
            let open = env::block_timestamp() < w.expires_at
                && w.max_uses.map_or(true, |cap| w.uses < cap);
            JoinWindowView {
                expires_at: w.expires_at.to_string(),
                max_uses: w.max_uses,
                uses: w.uses,
                open,
            }
        })
    }

    /// Free view: is this group self-joinable at all (created with joinable=true)?
    pub fn is_group_joinable(&self, group_id: String) -> bool {
        *self.joinable_groups.get(&group_id).unwrap_or(&false)
    }

    /// Free PUBLIC view of `get_group_members`. Returns members ONLY for groups created with joinable=true.
    pub fn get_group_members_public(&self, group_id: String) -> Vec<AccountId> {
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(
            *self.joinable_groups.get(&group_id).unwrap_or(&false),
            "Group is not joinable (public view refused)"
        );
        let members = self.group_members.get(&group_id).expect("Group members not found");
        members.iter().cloned().collect::<Vec<AccountId>>()
    }

    /// Free PUBLIC view of `get_transactions_for_group`. 
    pub fn get_transactions_for_group_public(&self, group_id: String) -> Vec<Transaction> {
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(
            *self.joinable_groups.get(&group_id).unwrap_or(&false),
            "Group is not joinable (public view refused)"
        );
        // Use the per-group index to avoid scanning all transactions:
        if let Some(tx_ids) = self.group_transactions.get(&group_id) {
            let mut out: Vec<Transaction> = Vec::new();
            for tx_id in tx_ids.iter() {
                if let Some(tx) = self.transactions.get(tx_id.as_str()) {
                    out.push(tx.clone());
                }
            }
            out
        } else {
            Vec::new()
        }
    }

    /// §5.5 — TOMBSTONE a transaction: mark it deleted, NEVER remove the record.
    /// The audit trail is the point of NOVA (§8.5), so the Transaction and its
    /// group index stay intact; only the deletion marker is added. Ciphertext
    /// removal (FastFS null-write) and crypto-shred (KV file-key destruction,
    /// §5.1/§6.2) happen off-chain; this is the on-chain audit anchor for them.
    ///
    /// Owner-gated: group owner OR contract owner (the retention/DeleteMemberFiles
    /// jobs sign as one of these). No fee for the contract owner, mirroring revoke.
    #[payable]
    pub fn tombstone_transaction(&mut self, trans_id: String, reason: DeletionReason) {
        let tx = self.transactions.get(&trans_id).expect("Transaction not found").clone();
        let group = self.groups.get(&tx.group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert!(caller == group.owner || caller == self.owner, "Only group owner or contract owner can tombstone");

        // Idempotent: re-tombstoning keeps the FIRST deletion record (audit integrity).
        let existing = self.tx_meta.get(&trans_id).cloned();
        if let Some(meta) = &existing {
            if meta.deleted.is_some() {
                log!("Transaction {} already tombstoned", trans_id);
                return;
            }
        }

        let record = DeletionRecord {
            deleted_at: env::block_timestamp(),
            deleted_by: caller,
            reason,
        };
        // Preserve backend/timestamp if a meta row exists (FastFS); else this is a
        // legacy IPFS tx being tombstoned — synthesise an Ipfs meta to hold the record.
        let meta = match existing {
            Some(m) => TxMeta { backend: m.backend, timestamp: m.timestamp, deleted: Some(record) },
            None => TxMeta { backend: StorageBackend::Ipfs, timestamp: 0, deleted: Some(record) },
        };
        self.tx_meta.insert(trans_id.clone(), meta);
        log!("Tombstoned transaction {}", trans_id);
    }

    /// Free view: per-transaction metadata (backend, upload time, deletion record),
    /// or None for legacy transactions with no meta row.
    pub fn get_transaction_meta(&self, trans_id: String) -> Option<TxMetaView> {
        self.tx_meta.get(&trans_id).map(|m| TxMetaView {
            backend: m.backend.clone(),
            timestamp: m.timestamp.to_string(),
            deleted: m.deleted.as_ref().map(|d| DeletionRecordView {
                deleted_at: d.deleted_at.to_string(),
                deleted_by: d.deleted_by.to_string(),
                reason: d.reason.clone(),
            }),
        })
    }

    /// Free view: is this transaction tombstoned?
    pub fn is_tombstoned(&self, trans_id: String) -> bool {
        self.tx_meta.get(&trans_id).map_or(false, |m| m.deleted.is_some())
    }

    // Returns list of group members
    #[payable]
    pub fn get_group_members(&mut self, group_id: String) -> Vec<AccountId> {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("get_group_members", attached);

        assert!(self.groups.contains_key(&group_id), "Group not found");

        let caller = env::predecessor_account_id();
        assert!(self.is_authorized(group_id.clone(), caller.clone()) || caller == self.owner, "Unauthorized");
        
        let members = self.group_members.get(&group_id).expect("Group members not found");
        members.iter().cloned().collect::<Vec<AccountId>>()
    }

    #[payable]
    pub fn record_transaction(&mut self, group_id: String, user_id: AccountId, file_hash: String, ipfs_hash: String, backend: Option<StorageBackend>) -> String {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("record_transaction", attached);
        
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(self.is_authorized(group_id.clone(), user_id.clone()), "User not authorized");

        let gid = group_id.clone();
        let trans_id = hex::encode(env::sha256(&format!(
            "{}{}{}{}{}",
            gid,
            user_id,
            file_hash,
            ipfs_hash,
            env::block_timestamp()
        ).as_bytes()));

        let tx = Transaction {
            group_id,
            user_id: user_id.to_string(),
            file_hash,
            ipfs_hash,
        };

        self.transactions.insert(trans_id.clone(), tx);

        // Append tx id to per-group transactions index (use gid here)
        if let Some(mut gtx) = self.group_transactions.remove(&gid) {
            gtx.push(trans_id.clone());
            self.group_transactions.insert(gid.clone(), gtx);
        } else {
            // Robust fallback: create the StoreVec with the same prefix you used in register_group
            let tx_prefix = format!("group_tx:{}", gid);
            let mut gtx = StoreVec::new(tx_prefix.as_bytes());
            gtx.push(trans_id.clone());
            self.group_transactions.insert(gid.clone(), gtx);
        }
        
        // record metadata for FastFS uploads (backend + upload timestamp,
        // consumed by §6.2 retention). Legacy/absent backend ⇒ IPFS ⇒ no meta row
        // (absence IS the IPFS-not-deleted default, so legacy callers cost nothing).
        if backend == Some(StorageBackend::FastFS) {
            self.tx_meta.insert(trans_id.clone(), TxMeta {
                backend: StorageBackend::FastFS,
                timestamp: env::block_timestamp(),
                deleted: None,
            });
        }

        log!("Transaction recorded: {}", trans_id);
        trans_id
    }

    #[payable]
    pub fn get_transactions_for_group(&mut self, group_id: String) -> Vec<Transaction> {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("get_transactions_for_group", attached);

        assert!(self.groups.contains_key(&group_id), "Group not found");
        
        let caller = env::predecessor_account_id();
        assert!(self.is_authorized(group_id.clone(), caller.clone()) || caller == self.owner, "Unauthorized");
        
        // Use the per-group index to avoid scanning all transactions:
        if let Some(tx_ids) = self.group_transactions.get(&group_id) {
            let mut out: Vec<Transaction> = Vec::new();
            for tx_id in tx_ids.iter() {
                if let Some(tx) = self.transactions.get(tx_id.as_str()) {
                    out.push(tx.clone());
                }
            }
            out
        } else {
            Vec::new()
        }
    }

    #[payable]
    pub fn update_checksum(&mut self, group_id: String, checksum: String) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("update_checksum", attached);
        
        let caller = env::predecessor_account_id();
        let group = self.groups.get(&group_id).expect("Group not found");
        assert_eq!(caller, group.owner, "Only group owner can update checksum");
        if let Some(group) = self.groups.get_mut(&group_id) {  // get_mut for mutable ref
            // Optional: Validate hex (32 bytes)
            hex::decode(&checksum).expect("Invalid hex checksum");
            group.shade_checksum = Some(checksum.clone());
            log!("Updated checksum for {}: {}", group_id, checksum);
        } else {
            env::panic_str("Group not found");
        }
    }

    pub fn get_group_checksum(&self, group_id: String) -> Option<String> {
        self.groups.get(&group_id).and_then(|g| g.shade_checksum.clone())
    }

    #[payable]
    pub fn approve_shade_code_hash(&mut self, code_hash: String) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("approve_shade_code_hash", attached);
        
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "Only owner can approve code hash");
        self.shade_code_hash = Some(code_hash.clone());
        log!("Approved Shade code hash: {}", code_hash);
    }

    pub fn register_shade_worker(&mut self, worker_id: AccountId, attestation: Vec<u8>) {
        let _expected_hash = self.shade_code_hash.as_ref().expect("No code hash approved");
        // Simplified verify (in local ac-proxy: assume valid; prod: integrate phala-sdk for TEE quote)
        let checksum = hex::encode(env::sha256(&attestation));
        self.workers.insert(worker_id.clone(), checksum.clone());
        log!("Registered Shade worker: {} with checksum {}", worker_id, checksum);
    }

    #[payable]
    pub fn claim_token(
        &mut self,
        group_id: String,
        payload_b64: String,
        signature_hex: String,
    ) -> String {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("claim_token", attached);

        let caller = env::predecessor_account_id();
        
        // Decode payload
        let payload_bytes = BASE64_STANDARD.decode(&payload_b64)
            .expect("Invalid base64 payload");
        let payload_str = String::from_utf8(payload_bytes.clone())
            .expect("Invalid UTF-8 payload");
        let payload: serde_json::Value = serde_json::from_str(&payload_str)
            .expect("Invalid JSON payload");
        
        // Extract and validate payload fields
        let payload_group_id = payload["group_id"].as_str().expect("Missing group_id");
        let payload_user_id = payload["user_id"].as_str().expect("Missing user_id");
        let nonce = payload["nonce"].as_str().expect("Missing nonce");
        let timestamp = payload["timestamp"].as_u64().expect("Missing timestamp");
        
        // Validate group_id matches
        assert_eq!(payload_group_id, group_id, "group_id mismatch");
        
        // Validate user is authorized
        let user_id: AccountId = payload_user_id.parse().expect("Invalid user_id");
        assert!(self.is_authorized(group_id.clone(), user_id.clone()), "Unauthorized caller");
        
        // Verify caller matches payload user_id (ensures only the user can claim their token)
        assert_eq!(caller, user_id, "Caller must match payload user_id");
        
        // Check timestamp freshness (5 min window)
        let now = env::block_timestamp();
        let five_min_ns = 300_000_000_000u64; // 5 minutes in nanoseconds
        assert!(
            timestamp <= now.saturating_add(five_min_ns) && 
            timestamp >= now.saturating_sub(five_min_ns),
            "Token timestamp expired or future"
        );
        
        // Check nonce hasn't been used (replay protection)
        let nonce_key = format!("{}.{}.{}", group_id, user_id, nonce);
        assert!(!self.used_nonces.contains_key(&nonce_key), "Nonce already used (replay attack)");
        
        // Decode signature
        let sig_bytes_vec = hex::decode(&signature_hex).expect("Invalid hex signature");
        assert_eq!(sig_bytes_vec.len(), 64, "Signature must be 64 bytes");
        let sig_bytes: [u8; 64] = sig_bytes_vec.try_into().expect("Sig conversion failed");
        
        // Get the public key of the transaction signer
        let signer_pk = env::signer_account_pk();
        let pk_bytes = signer_pk.as_bytes();
        let pk_array: [u8; 32] = pk_bytes[1..33].try_into().expect("Invalid pk length"); // Skip tag byte (0x00 for Ed25519)
        
        // Verify ed25519 signature using NEAR's built-in function
        let is_valid = env::ed25519_verify(&sig_bytes, payload_str.as_bytes(), &pk_array);
        assert!(is_valid, "Invalid signature on payload");
        
        // Mark nonce as used (only after all validations pass)
        self.used_nonces.insert(nonce_key, true);
        
        // Return complete token
        let token = format!("{}.{}", payload_b64, signature_hex);
        log!("Issued verified token for {}/{}", group_id, user_id);
        token
    }

    // View for Shade verification
    pub fn get_nonce_validity(&self, group_id: String, user_id: AccountId, nonce: String) -> bool {
        let nonce_key = format!("{}.{}.{}", group_id, user_id, nonce);
        !self.used_nonces.contains_key(&nonce_key)
    }

    // Private: request_signature via Shade API; restricts to nova_key_ paths
    pub fn request_signature(&self, path: String, payload: Vec<u8>, key_type: String) -> String {
        let _ = key_type; // explicitly mark as unused to avoid warning
        assert!(path.starts_with("nova_key_"), "Restricted path: key ops only");
        // Stub: Return dummy sig (prod: Promise to MPC/Shade)
        hex::encode(env::sha256(&payload))  // Placeholder
    }
}

// Inline tests (not compiled into the final contract)
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, Gas};
    use near_crypto::{SecretKey};
    use near_sdk::NearToken;

    fn get_context(
        signer: AccountId,
        attached_yocto: u128,
    ) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .signer_account_id(signer.clone())
            .predecessor_account_id(signer)
            .attached_deposit(NearToken::from_yoctonear(attached_yocto))
            .prepaid_gas(Gas::from_tgas(1500));
        builder
    }

    #[test]
    fn test_new_initializes_without_jwt() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let contract = Contract::new(owner.clone(), shade_id.clone(), fee_recipient.clone());
        assert_eq!(contract.owner, owner);
        assert_eq!(contract.shade_contract_id, shade_id);
        assert_eq!(contract.fee_recipient, fee_recipient);
        assert!(contract.fees.contains_key(&"register_group".to_string()));
        assert_eq!(contract.estimate_fee("register_group".to_string()), 50_000_000_000_000_000_000_000u128);
    }

    #[test]
    fn register_group_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 100_000_000_000_000_000_000_000u128;  // 0.1 NEAR > 0.05 fee
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        assert!(contract.groups.contains_key(&"test_group".to_string()));
    }

    #[test]
    #[should_panic(expected = "Attach at least 50000000000000000000000 yoctoNEAR for fee")]
    fn register_group_fails_insufficient_deposit() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let insufficient = 10_000_000_000_000_000_000u128;  // < 0.05 NEAR
        let context = get_context(owner.clone(), insufficient);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
    }

    #[test]
    fn register_group_works_for_any_caller() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "not_owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 100_000_000_000_000_000_000_000u128;  // 0.1 NEAR > 0.05 fee
        let mut context = get_context(owner.clone(), 0);  // Init without deposit
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        context = get_context(non_owner.clone(), attached);  // Set deposit for caller
        testing_env!(context.build());
        contract.register_group("test_group".to_string(), None);

        // Verify group was created with non_owner as owner
        assert!(contract.groups.contains_key(&"test_group".to_string()));
        assert_eq!(contract.get_group_owner("test_group".to_string()), non_owner);

        // Verify non_owner is a member
        assert!(contract.is_authorized("test_group".to_string(), non_owner.clone()));
    }

    #[test]
    fn add_group_member_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_register = 100_000_000_000_000_000_000_000u128;  // 0.1 NEAR > 0.05 fee for register
        let attached_add = 10_000_000_000_000_000_000u128;  // 0.01 NEAR > 0.001 fee for add
        let mut context = get_context(owner.clone(), attached_register);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);  // Fee paid in context
        context = get_context(owner.clone(), attached_add);
        testing_env!(context.build());
        contract.add_group_member("test_group".to_string(), member.clone());
        assert!(contract.is_authorized("test_group".to_string(), member));
    }

    #[test]
    #[should_panic(expected = "Only group owner can add")]
    fn add_group_member_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "not_owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);  // Sufficient for register
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        context = get_context(non_owner, 10_000_000_000_000_000_000u128);  // Sufficient for add, but logic fails
        testing_env!(context.build());
        contract.add_group_member("test_group".to_string(), member);
    }

    #[test]
    fn revoke_group_member_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_register = 100_000_000_000_000_000_000_000u128;  // For register
        let attached_add = 10_000_000_000_000_000_000u128;  // For add
        let attached_revoke = 10_000_000_000_000_000_000u128;  // For revoke
        let mut context = get_context(owner.clone(), attached_register);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        context = get_context(owner.clone(), attached_add);
        testing_env!(context.build());
        contract.add_group_member("test_group".to_string(), member.clone());
        context = get_context(owner.clone(), attached_revoke);
        testing_env!(context.build());
        contract.revoke_group_member("test_group".to_string(), member.clone());
        assert!(!contract.is_authorized("test_group".to_string(), member));
    }

    #[test]
    #[should_panic(expected = "User not a member")]
    fn revoke_group_member_fails_non_member() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);  // Sufficient for register
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        context = get_context(owner.clone(), 10_000_000_000_000_000_000u128);  // Sufficient for revoke, but logic fails
        testing_env!(context.build());
        contract.revoke_group_member("test_group".to_string(), member);
    }

    #[test]
    fn record_transaction_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_register = 100_000_000_000_000_000_000_000u128;  // For register
        let attached_add = 10_000_000_000_000_000_000u128;  // For add
        let attached_record = 10_000_000_000_000_000_000u128;  // For record > 0.002
        let mut context = get_context(owner.clone(), attached_register);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        context = get_context(owner.clone(), attached_add);
        testing_env!(context.build());
        contract.add_group_member("test_group".to_string(), member.clone());
        context = get_context(owner.clone(), attached_record);
        testing_env!(context.build());
        let trans_id = contract.record_transaction(
            "test_group".to_string(),
            member.clone(),
            "file_hash".to_string(),
            "ipfs_hash".to_string(),
        );
        let transactions = contract.get_transactions_for_group("test_group".to_string());
        assert_eq!(transactions.len(), 1);
        assert_eq!(transactions[0].group_id, "test_group");
        assert_eq!(transactions[0].user_id, member.to_string());
        assert_eq!(transactions[0].file_hash, "file_hash");
        assert_eq!(transactions[0].ipfs_hash, "ipfs_hash");
        assert!(contract.transactions.contains_key(&trans_id));
    }

    #[test]
    fn record_transaction_works_for_member() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_owner = 110_000_000_000_000_000_000_000u128;  // For register/add
        let attached_member = 10_000_000_000_000_000_000u128;  // For record
        let context = get_context(owner.clone(), attached_owner);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());
        let member_context = get_context(member.clone(), attached_member);  // Member attaches for record
        testing_env!(member_context.build());
        let trans_id = contract.record_transaction(
            "test_group".to_string(),
            member.clone(),
            "file_hash".to_string(),
            "ipfs_hash".to_string(),
        );
        assert!(contract.transactions.contains_key(&trans_id));
    }

    #[test]
    #[should_panic(expected = "User not authorized")]
    fn record_transaction_fails_unauthorized() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_member: AccountId = "non_member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);  // Sufficient for register
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        context = get_context(non_member.clone(), 10_000_000_000_000_000_000u128);  // Sufficient for record, but logic fails
        testing_env!(context.build());
        contract.record_transaction(
            "test_group".to_string(),
            non_member,
            "file_hash".to_string(),
            "ipfs_hash".to_string(),
        );
    }

    #[test]
    fn get_transactions_for_group_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 130_000_000_000_000_000_000_000u128;  // Sufficient for chain
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());
        contract.record_transaction(
            "test_group".to_string(),
            member.clone(),
            "file_hash1".to_string(),
            "ipfs_hash1".to_string(),
        );
        contract.record_transaction(
            "test_group".to_string(),
            member.clone(),
            "file_hash2".to_string(),
            "ipfs_hash2".to_string(),
        );
        let transactions = contract.get_transactions_for_group("test_group".to_string());
        assert_eq!(transactions.len(), 2);
        assert!(transactions.iter().any(|tx| tx.file_hash == "file_hash1" && tx.ipfs_hash == "ipfs_hash1"));
        assert!(transactions.iter().any(|tx| tx.file_hash == "file_hash2" && tx.ipfs_hash == "ipfs_hash2"));
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn get_transactions_for_group_fails_unauthorized() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_member: AccountId = "non_member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);  // For register
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        let view_context = get_context(non_member.clone(), 100_000_000_000_000_000u128);  // deposit
        testing_env!(view_context.build());
        contract.get_transactions_for_group("test_group".to_string());
    }

    #[test]
    fn get_group_members_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 110_000_000_000_000_000_000_000u128;  // For register/add
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());
        let members = contract.get_group_members("test_group".to_string());
        assert_eq!(members.len(), 2);
        assert!(members.contains(&owner));
        assert!(members.contains(&member));
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn get_group_members_fails_unauthorized() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_member: AccountId = "non_member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);  // Sufficient for register
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        let view_context = get_context(non_member.clone(), 100_000_000_000_000_000u128);  // deposit
        testing_env!(view_context.build());
        contract.get_group_members("test_group".to_string());
    }

    #[test]
    fn approve_shade_code_hash_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 1_000_000_000_000_000_000u128;  // 0.001 > 0.0001 fee
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        contract.approve_shade_code_hash("dummy_hash".to_string());
        assert_eq!(contract.shade_code_hash, Some("dummy_hash".to_string()));
    }

    #[test]
    #[should_panic(expected = "Only owner can approve code hash")]
    fn approve_shade_code_hash_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "non_owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        context = get_context(non_owner, 1_000_000_000_000_000_000u128);  // Sufficient for approve, but logic fails
        testing_env!(context.build());
        contract.approve_shade_code_hash("dummy_hash".to_string());
    }

    #[test]
    fn register_shade_worker_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 2_000_000_000_000_000_000u128);  // For approve
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.approve_shade_code_hash("dummy_hash".to_string());
        let worker: AccountId = "worker.testnet".parse().unwrap();
        let attestation = vec![0u8; 64];
        contract.register_shade_worker(worker.clone(), attestation);
        assert!(contract.workers.contains_key(&worker));
    }

    #[test]
    #[should_panic(expected = "No code hash approved")]
    fn register_shade_worker_fails_no_hash() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        let worker: AccountId = "worker.testnet".parse().unwrap();
        let attestation = vec![0u8; 64];
        contract.register_shade_worker(worker, attestation);
    }

    #[test]
    fn claim_token_works() {    
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_owner = 110_000_000_000_000_000_000_000u128;  // For register/add
        let attached_member = 2_000_000_000_000_000_000u128;  // Sufficient for claim
        let mut context = get_context(owner.clone(), attached_owner);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());

        // Create a test Ed25519 keypair for signing
        let secret_key = SecretKey::from_seed(near_crypto::KeyType::ED25519, "test_seed");
        let crypto_public_key = secret_key.public_key();

        // Convert near_crypto::PublicKey to near_sdk::PublicKey
        let public_key_str = crypto_public_key.to_string();
        let sdk_public_key: near_sdk::PublicKey = public_key_str.parse().unwrap();

        // Switch to member context with the test public key and attached deposit
        context = get_context(member.clone(), attached_member);
        context.signer_account_pk(sdk_public_key);
        testing_env!(context.build());

        // Build valid payload
        let timestamp = env::block_timestamp();
        let nonce_input = format!("{}{}{}", "test_group", member, timestamp);
        let nonce = hex::encode(Sha256::digest(nonce_input.as_bytes()));
        let payload_json = json!({
            "group_id": "test_group",
            "user_id": member.to_string(),
            "nonce": nonce.clone(),
            "timestamp": timestamp
        });
        let payload_str = payload_json.to_string();
        let payload_b64 = BASE64_STANDARD.encode(payload_str.as_bytes());

        // Sign the payload with the secret key
        let signature = secret_key.sign(payload_str.as_bytes());
        // Extract the signature bytes based on the signature type
        let signature_bytes = match signature {
            near_crypto::Signature::ED25519(sig) => sig.to_bytes(),
            _ => panic!("Expected ED25519 signature"),
        };
        let signature_hex = hex::encode(signature_bytes);

        // Call claim_token
        let token = contract.claim_token(
            "test_group".to_string(),
            payload_b64.clone(),
            signature_hex.clone()
        );

        // Assert token returned in expected format
        assert_eq!(token, format!("{}.{}", payload_b64, signature_hex));

        // Verify nonce is marked as used
        assert!(!contract.get_nonce_validity("test_group".to_string(), member, nonce));
    }

    #[test]
    #[should_panic(expected = "Attach at least 1000000000000000000 yoctoNEAR for fee")]
    fn claim_token_fails_insufficient_deposit() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_owner = 110_000_000_000_000_000_000_000u128;  // For chain
        let insufficient = 500_000_000_000_000_000u128;  // < 0.001 NEAR for claim
        let mut context = get_context(owner.clone(), attached_owner);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());

        // Member context with insufficient deposit
        context = get_context(member.clone(), insufficient);
        testing_env!(context.build());

        // Valid payload but insufficient deposit
        let timestamp = env::block_timestamp();
        let nonce_input = format!("{}{}{}", "test_group", member, timestamp);
        let nonce = hex::encode(Sha256::digest(nonce_input.as_bytes()));
        let payload = json!({
            "group_id": "test_group",
            "user_id": member.to_string(),
            "nonce": nonce,
            "timestamp": timestamp
        }).to_string();
        let payload_b64 = BASE64_STANDARD.encode(payload.as_bytes());
        let invalid_sig_hex = hex::encode(vec![1u8; 64]);  // Dummy sig for test

        contract.claim_token("test_group".to_string(), payload_b64, invalid_sig_hex);
    }

    #[test]
    #[should_panic(expected = "Invalid signature on payload")]
    fn claim_token_fails_invalid_sig() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached_owner = 110_000_000_000_000_000_000_000u128;  // For chain
        let attached_member = 2_000_000_000_000_000_000u128;  // Sufficient for claim
        let mut context = get_context(owner.clone(), attached_owner);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());

        // Member context with deposit
        context = get_context(member.clone(), attached_member);
        testing_env!(context.build());

        // Valid payload but invalid sig
        let timestamp = env::block_timestamp();
        let nonce_input = format!("{}{}{}", "test_group", member, timestamp);
        let nonce = hex::encode(Sha256::digest(nonce_input.as_bytes()));
        let payload = json!({
            "group_id": "test_group",
            "user_id": member.to_string(),
            "nonce": nonce,
            "timestamp": timestamp
        }).to_string();
        let payload_b64 = BASE64_STANDARD.encode(payload.as_bytes());

        let invalid_sig_hex = hex::encode(vec![1u8; 64]);  // Invalid for hash

        contract.claim_token("test_group".to_string(), payload_b64, invalid_sig_hex);
    }

    #[test]
    fn get_nonce_validity_works_fresh() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 110_000_000_000_000_000_000_000u128;  // For chain
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());

        // Test that a fresh (unused) nonce is valid
        let fresh_nonce = "some_fresh_nonce_that_was_never_used";
        let valid = contract.get_nonce_validity("test_group".to_string(), member.clone(), fresh_nonce.to_string());
        assert!(valid, "Fresh nonce should be valid");
    }

    #[test]
    fn get_nonce_validity_fails_used() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 110_000_000_000_000_000_000_000u128);  // For chain
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("test_group".to_string(), None);
        contract.add_group_member("test_group".to_string(), member.clone());
    
        // Generate a nonce
        let timestamp = env::block_timestamp();
        let nonce_input = format!("{}{}{}", "test_group", member, timestamp);
        let nonce = hex::encode(Sha256::digest(nonce_input.as_bytes()));
        
        // Check nonce is initially valid (not used)
        let valid_before = contract.get_nonce_validity(
            "test_group".to_string(), 
            member.clone(), 
            nonce.clone()
        );
        assert!(valid_before, "Fresh nonce should be valid");
        
        // Manually mark the nonce as used (simulating successful claim_token)
        let nonce_key = format!("{}.{}.{}", "test_group", member, nonce);
        contract.used_nonces.insert(nonce_key, true);
        
        // Verify that the used nonce is now invalid
        let valid_after = contract.get_nonce_validity(
            "test_group".to_string(), 
            member.clone(), 
            nonce.clone()
        );
        assert!(!valid_after, "Used nonce should be invalid");
    }

    #[test]
    fn request_signature_guarded_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);  // No fee
        testing_env!(context.build());
        let contract = Contract::new(owner, shade_id, fee_recipient);
        let sig = contract.request_signature("nova_key_test".to_string(), vec![0u8; 32], "Ecdsa".to_string());
        assert!(!sig.is_empty());
    }

    #[test]
    #[should_panic(expected = "Restricted path: key ops only")]
    fn request_signature_fails_invalid_path() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let contract = Contract::new(owner, shade_id, fee_recipient);
        contract.request_signature("invalid_path".to_string(), vec![0u8; 32], "Ecdsa".to_string());
    }

    #[test]
    fn set_fee_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let attached = 1_000_000_000_000_000_000u128;  // For set_fee payable
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        let new_fee = 100_000_000_000_000_000_000u128;  // 0.1 NEAR
        contract.set_fee("register_group".to_string(), new_fee.to_string());
        assert_eq!(contract.estimate_fee("register_group".to_string()), new_fee);
    }

    #[test]
    #[should_panic(expected = "Only owner can set fees")]
    fn set_fee_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "non_owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        context = get_context(non_owner, 0);
        testing_env!(context.build());
        contract.set_fee("register_group".to_string(), "1000000000000000000".to_string());
    }

    #[test]
    fn set_fee_recipient_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let initial_recipient: AccountId = "initial.testnet".parse().unwrap();
        let new_recipient: AccountId = "nova-sdk.mainnet".parse().unwrap();  // For mainnet switch
        let attached = 1_000_000_000_000_000_000u128;  // Assume fee for set_fee_recipient (add if needed)
        let context = get_context(owner.clone(), attached);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, initial_recipient);
        contract.set_fee_recipient(new_recipient.clone());
        assert_eq!(contract.fee_recipient, new_recipient);
    }

    #[test]
    #[should_panic(expected = "Only owner can update recipient")]
    fn set_fee_recipient_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "non_owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let mut contract = Contract::new(owner, shade_id, fee_recipient);
        context = get_context(non_owner, 0);
        testing_env!(context.build());
        contract.set_fee_recipient("new.testnet".parse().unwrap());
    }

    #[test]
    fn estimate_fee_returns_default_if_unset() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let contract = Contract::new(owner, shade_id, fee_recipient);
        assert_eq!(contract.estimate_fee("unset_action".to_string()), 0);  // Defaults to 0 if not set
    }

    #[test]
    fn get_dynamic_fee_placeholder() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let contract = Contract::new(owner, shade_id, fee_recipient);
        assert_eq!(contract.get_dynamic_fee("register_group".to_string()), 0);  // Stub returns 0
        // TODO: Expand when integrating Chainlink
    }

    
    // ---- SECURITY INVARIANT ----
    
    #[test]
    #[should_panic(expected = "Group is not joinable")]
    fn t2_1_plain_group_cannot_be_opened() {
        // THE CORE TEST: a group registered WITHOUT joinable=true can never be opened.
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("plain_group".to_string(), None); // NOT joinable
        // Attempt to open — must panic "not joinable"
        let future = env::block_timestamp() + 1_000_000_000;
        contract.open_hackathon_join("plain_group".to_string(), U64(future), None);
    }
    
    #[test]
    #[should_panic(expected = "Group is not joinable")]
    fn t2_2_explicit_false_cannot_be_opened() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("grp".to_string(), Some(false)); // explicit false
        let future = env::block_timestamp() + 1_000_000_000;
        contract.open_hackathon_join("grp".to_string(), U64(future), None);
    }
    
    #[test]
    #[should_panic(expected = "Only group owner can open join")]
    fn t2_3_non_owner_cannot_open() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("joinable_grp".to_string(), Some(true));
        // stranger tries to open owner's joinable group
        context = get_context(stranger, 0);
        testing_env!(context.build());
        let future = env::block_timestamp() + 1_000_000_000;
        contract.open_hackathon_join("joinable_grp".to_string(), U64(future), None);
    }
    
    #[test]
    #[should_panic(expected = "Group not open for join")]
    fn t2_4_join_with_no_window_panics() {
        // Even a joinable group cannot be joined until a window is opened.
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("joinable_grp".to_string(), Some(true));
        // no open_hackathon_join call
        context = get_context(stranger.clone(), 10_000_000_000_000_000_000u128);
        testing_env!(context.build());
        contract.join_group("joinable_grp".to_string());
    }
    
    // ---- HAPPY PATH ----
    
    #[test]
    fn t2_5_full_join_flow_succeeds() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
    
        // owner opens the window
        let future = env::block_timestamp() + 1_000_000_000_000; // 1000s out
        contract.open_hackathon_join("hack".to_string(), U64(future), None);
    
        // is_group_joinable view
        assert!(contract.is_group_joinable("hack".to_string()));
    
        // stranger self-joins (join_group fee is 0 in unit tests — not in new() defaults)
        context = get_context(stranger.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
    
        // stranger is now authorized
        assert!(contract.is_authorized("hack".to_string(), stranger.clone()));
    
        // window uses incremented
        let window = contract.get_join_window("hack".to_string()).unwrap();
        assert_eq!(window.uses, 1);
        assert!(window.open);
    }
    
    #[test]
    fn t2_6_joiner_appears_in_member_groups() {
        // Proves the member_groups index bookkeeping mirrors add_group_member.
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        let future = env::block_timestamp() + 1_000_000_000_000;
        contract.open_hackathon_join("hack".to_string(), U64(future), None);
    
        context = get_context(stranger.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
    
        // stranger's member_groups (via get_member_groups, which reads the index)
        // fee for get_member_groups is 0.0001 — attach it
        context = get_context(stranger.clone(), 100_000_000_000_000_000u128);
        testing_env!(context.build());
        let groups = contract.get_member_groups();
        assert!(groups.contains(&"hack".to_string()),
            "joined group must appear in member_groups (index bookkeeping)");
    }
    
    // ---- WINDOW SEMANTICS ----
    
    #[test]
    #[should_panic(expected = "Join window closed")]
    fn t2_8_join_after_expiry_panics() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        // open with expiry 1ns in the future, then advance block_timestamp past it
        let now = env::block_timestamp();
        contract.open_hackathon_join("hack".to_string(), U64(now + 1), None);
    
        // advance time past expiry
        let mut b = get_context(stranger.clone(), 0);
        b.block_timestamp(now + 1_000_000); // well past now+1
        testing_env!(b.build());
        contract.join_group("hack".to_string());
    }
    
    #[test]
    #[should_panic(expected = "Join window full")]
    fn t2_9_max_uses_cap_enforced() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let s1: AccountId = "s1.testnet".parse().unwrap();
        let s2: AccountId = "s2.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        let future = env::block_timestamp() + 1_000_000_000_000;
        contract.open_hackathon_join("hack".to_string(), U64(future), Some(1)); // cap = 1
    
        // first join OK
        context = get_context(s1.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
    
        // second join exceeds cap -> panic
        context = get_context(s2.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
    }
    
    #[test]
    #[should_panic(expected = "Already a member")]
    fn t2_10_double_join_panics() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        let future = env::block_timestamp() + 1_000_000_000_000;
        contract.open_hackathon_join("hack".to_string(), U64(future), None);
    
        context = get_context(stranger.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
        // same account joins again -> panic
        contract.join_group("hack".to_string());
    }
    
    #[test]
    #[should_panic(expected = "Group not open for join")]
    fn t2_11_close_then_join_panics() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let stranger: AccountId = "stranger.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        let future = env::block_timestamp() + 1_000_000_000_000;
        contract.open_hackathon_join("hack".to_string(), U64(future), None);
        contract.close_hackathon_join("hack".to_string());
    
        context = get_context(stranger.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());
    }
    
    // ---- FEE ----
    
    #[test]
    fn t2_13_join_fee_zero_until_set_then_enforced() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 1_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        // join_group not in new() defaults -> fee 0
        assert_eq!(contract.estimate_fee("join_group".to_string()), 0);
        // owner sets it (mirrors the post-deploy step)
        contract.set_fee("join_group".to_string(), "1000000000000000000".to_string());
        assert_eq!(contract.estimate_fee("join_group".to_string()), 1_000_000_000_000_000_000u128);
    }
    
    // ---- LEGACY SAFETY (unit-level shadow of integration T2.14) ----
    
    #[test]
    fn t2_legacy_group_is_not_joinable() {
        // A group created the OLD way (None) is not joinable and cannot be opened.
        // The integration test proves this survives a real wasm UPGRADE; here we
        // prove the logic: absence from joinable_groups => is_group_joinable false.
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("legacy".to_string(), None);
        assert!(!contract.is_group_joinable("legacy".to_string()));
        assert!(contract.get_join_window("legacy".to_string()).is_none());
    }
    // SECURITY INVARIANT: a plain (non-joinable) group REFUSES the public views.
    #[test]
    #[should_panic(expected = "Group is not joinable")]
    fn t3_1_members_public_panics_on_plain_group() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("plain".to_string(), None); // NOT joinable
        contract.get_group_members_public("plain".to_string());
    }

    #[test]
    #[should_panic(expected = "Group is not joinable")]
    fn t3_2_transactions_public_panics_on_plain_group() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("plain".to_string(), None);
        contract.get_transactions_for_group_public("plain".to_string());
    }

    #[test]
    #[should_panic(expected = "Group is not joinable")]
    fn t3_3_members_public_panics_on_explicit_false() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("grp".to_string(), Some(false)); // explicit false
        contract.get_group_members_public("grp".to_string());
    }

    #[test]
    #[should_panic(expected = "Group not found")]
    fn t3_4_members_public_panics_on_missing_group() {
        // Proves the not-found check fires BEFORE the joinable check.
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 0);
        testing_env!(context.build());
        let contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.get_group_members_public("nonexistent".to_string());
    }

    // PARITY: on a joinable group the public twin byte-matches the signed method.
    #[test]
    fn t3_5_members_public_matches_signed_on_joinable() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let s1: AccountId = "s1.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let mut context = get_context(owner.clone(), 100_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true));
        let future = env::block_timestamp() + 1_000_000_000_000;
        contract.open_hackathon_join("hack".to_string(), U64(future), None);

        // stranger self-joins so membership is non-trivial (owner + s1)
        context = get_context(s1.clone(), 0);
        testing_env!(context.build());
        contract.join_group("hack".to_string());

        // signed path: owner, fee attached
        context = get_context(owner.clone(), 100_000_000_000_000_000u128);
        testing_env!(context.build());
        let signed = contract.get_group_members("hack".to_string());

        // public path: unrelated caller, no fee
        let nobody: AccountId = "nobody.testnet".parse().unwrap();
        context = get_context(nobody, 0);
        testing_env!(context.build());
        let public = contract.get_group_members_public("hack".to_string());

        assert_eq!(signed, public, "public twin must byte-match signed method");
        assert_eq!(public.len(), 2);
    }

    #[test]
    fn t3_6_transactions_public_matches_signed_on_joinable() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let shade_id: AccountId = "shade.testnet".parse().unwrap();
        let fee_recipient: AccountId = "nova-sdk-4.testnet".parse().unwrap();
        let context = get_context(owner.clone(), 200_000_000_000_000_000_000_000u128);
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone(), shade_id, fee_recipient);
        contract.register_group("hack".to_string(), Some(true)); // owner auto-member
        contract.record_transaction(
            "hack".to_string(),
            owner.clone(),
            "fh1".to_string(),
            "ih1".to_string(),
        );

        let signed = contract.get_transactions_for_group("hack".to_string());
        let public = contract.get_transactions_for_group_public("hack".to_string());

        assert_eq!(signed.len(), 1);
        assert_eq!(public.len(), signed.len());
        assert_eq!(public[0].file_hash, signed[0].file_hash);
        assert_eq!(public[0].ipfs_hash, signed[0].ipfs_hash);
        assert_eq!(public[0].group_id, signed[0].group_id);
        assert_eq!(public[0].user_id, signed[0].user_id);
    }
}
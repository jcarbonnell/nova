// NOVA contract v0.3.0 - multi-user w/ Shade/TEEs + pay-per-action fees
use near_sdk::{env, log, near, AccountId, BorshStorageKey, PanicOnDefault, Promise};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::{LookupMap, Vector as StoreVec, IterableMap};
use near_sdk::serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use near_sdk::serde_json;
use near_sdk::serde_json::json;
use near_sdk::NearToken;
use hex;
use near_sdk::base64::{Engine, engine::general_purpose::STANDARD as BASE64_STANDARD};
use sha2::{Sha256, Digest};
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
    ipfs_hash: String,
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
    // Integrate Chainlink CCIP on NEAR (confirmed mature in 2025 via searches; deploy oracle contract separately)
    pub fn get_dynamic_fee(&self, _action: String) -> u128 {
        // TODO: Call Chainlink oracle (e.g., Promise to oracle contract for feed)
        // Example: near_usd_price = oracle::get_feed("NEAR/USD");
        // ipfs_cost = oracle::get_feed("IPFS/GB"); // Custom feed if needed
        // return base_fee(action) * near_usd_price + ipfs_cost * file_size_estimate;
        0  // Placeholder: Use static for now
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
    pub fn register_group(&mut self, group_id: String) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("register_group", attached);

        assert!(!self.groups.contains_key(&group_id), "Group exists");
        let caller = env::predecessor_account_id();
        let group = Group { owner: caller.clone(), shade_checksum: None };
        self.groups.insert(group_id.clone(), group);
        let mut members = StoreVec::new(group_id.as_bytes());
        members.push(caller.clone());
        self.group_members.insert(group_id.clone(), members);
        log!("Group {} registered by {} (owner added as member; event emitted for Shade key init)", group_id, caller);
        
        // add to owned_groups
        {
            let prefix = format!("owned:{}", caller);
            let mut owned = StoreVec::new(prefix.as_bytes());
            if let Some(existing) = self.owned_groups.get(&caller) {
                for g in existing.iter() {
                    owned.push(g.clone());
                }
            }
            owned.push(group_id.clone());
            self.owned_groups.insert(caller.clone(), owned);
        }

        // add to member_groups
        {
            let prefix = format!("member:{}", caller);
            let mut member = StoreVec::new(prefix.as_bytes());
            if let Some(existing) = self.member_groups.get(&caller) {
                for g in existing.iter() {
                    member.push(g.clone());
                }
            }
            member.push(group_id.clone());
            self.member_groups.insert(caller.clone(), member);
        }

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

    // Returns list of group members (owner or member only)
    pub fn get_group_members(&self, group_id: String, user_id: AccountId) -> Vec<AccountId> {
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(self.is_authorized(group_id.clone(), user_id.clone()) || user_id == self.owner, "Unauthorized");
        let members = self.group_members.get(&group_id).expect("Group members not found");
        members.iter().cloned().collect::<Vec<AccountId>>()  // Clone and collect from iter (O(n) gas, safe for small groups)
    }

    // Returns list of groups owned by the user
    pub fn get_owned_groups(&self, user_id: AccountId) -> Vec<String> {
        let caller = env::predecessor_account_id();
        assert_eq!(caller, user_id, "Only the wallet owner can query their owned groups");
        self.owned_groups
            .get(&user_id)
            .map(|v| v.iter().cloned().collect())
            .unwrap_or_default()
    }

    // Returns list of groups where the user is a member (includes owned groups)
    pub fn get_member_groups(&self, user_id: AccountId) -> Vec<String> {
        let caller = env::predecessor_account_id();
        assert_eq!(caller, user_id, "Only the wallet owner can query their membership groups");
        self.member_groups
            .get(&user_id)
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

        // add new member to member_groups index
        {
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
    }

    #[payable]
    pub fn revoke_group_member(&mut self, group_id: String, user_id: AccountId) {
        let attached = env::attached_deposit().as_yoctonear();
        self.collect_fee("revoke_group_member", attached);
        
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can revoke");
        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        if let Some(pos) = members.iter().position(|x| x == &user_id) {
            members.swap_remove(pos.try_into().unwrap());
            log!("Revoked {} from group {} (rotated key in Shade)", user_id, group_id);

            // remove member from member_groups index
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

    #[payable]
    pub fn record_transaction(&mut self, group_id: String, user_id: AccountId, file_hash: String, ipfs_hash: String) -> String {
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
        
        log!("Transaction recorded: {}", trans_id);
        trans_id
    }

    pub fn get_transactions_for_group(&self, group_id: String, user_id: AccountId) -> Vec<Transaction> {
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(self.is_authorized(group_id.clone(), user_id.clone()) || user_id == self.owner, "Unauthorized");
        self.transactions
            .values()
            .filter(|tx| tx.group_id == group_id)
            .cloned()
            .collect()
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());

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
        contract.register_group("test_group".to_string());  // Fee paid in context
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        let transactions = contract.get_transactions_for_group("test_group".to_string(), member.clone());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        let transactions = contract.get_transactions_for_group("test_group".to_string(), member.clone());
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
        contract.register_group("test_group".to_string());
        let view_context = get_context(non_member.clone(), 0);  // View no deposit
        testing_env!(view_context.build());
        contract.get_transactions_for_group("test_group".to_string(), non_member);
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
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());
        let members = contract.get_group_members("test_group".to_string(), owner.clone());
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
        contract.register_group("test_group".to_string());
        let view_context = get_context(non_member.clone(), 0);  // View no deposit
        testing_env!(view_context.build());
        contract.get_group_members("test_group".to_string(), non_member);
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
        contract.register_group("test_group".to_string());
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
}
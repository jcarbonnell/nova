// NOVA contract version 0.2.0 - hybridation with Shade/TEEs
use near_sdk::{env, log, near, AccountId, BorshStorageKey, PanicOnDefault, Promise};
use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::store::{LookupMap, Vector as StoreVec, IterableMap};
use near_sdk::base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use near_sdk::serde::{Deserialize, Serialize};
use schemars::JsonSchema;
use serde_json::json;

// Define the contract structure
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    groups: LookupMap<String, Group>,
    group_members: LookupMap<String, StoreVec<AccountId>>,
    transactions: IterableMap<String, Transaction>,
    shade_code_hash: Option<String>,
    workers: LookupMap<AccountId, String>,
}

#[derive(BorshStorageKey, BorshSerialize)]
enum StorageKey {
    Groups,
    GroupMembers,
    Transactions,
    Workers,
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
pub struct Group {
    owner: AccountId,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct Transaction {
    group_id: String,
    user_id: String,
    file_hash: String,
    ipfs_hash: String,
}

// Implement the contract structure
#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            groups: LookupMap::new(StorageKey::Groups),
            group_members: LookupMap::new(StorageKey::GroupMembers),
            transactions: IterableMap::new(StorageKey::Transactions),
            shade_code_hash: None,
            workers: LookupMap::new(StorageKey::Workers),
        }
    }

    #[payable]
    pub fn register_group(&mut self, group_id: String) {
        assert!(!self.groups.contains_key(&group_id), "Group exists");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "Only owner can register");  // MVP: limit to owner, add agents later.
        let group = Group { owner: caller.clone() };
        self.groups.insert(group_id.clone(), group);
        // Create new members vector for this group
        let mut members = StoreVec::new(group_id.as_bytes());
        // Add owner as a member
        members.push(caller.clone());
        self.group_members.insert(group_id.clone(), members);
        log!("Group {} registered by {} (owner added as member; signal Shade for key init)", group_id, caller);
        // group creation auto-triggers key gen in Shade
        let shade_contract = "shade-agent.nova-shade-agent.testnet".parse().unwrap();  // Your Shade contract ID
        let args = json!({ "group_id": group_id, "owner": caller.to_string() }).to_string().into_bytes();
        Promise::new(shade_contract)
            .function_call("generate_key".to_string(), args, 0, 300_000_000_000_000u64)  // Gas for Shade call; adjust
            .then(  // Optional: Callback to this contract (e.g., log success)
                Promise::new(env::current_account_id())
                    .function_call("on_key_generated".to_string(), b"{}", 0, 100_000_000_000_000u64)
            );
    }

    // Callback stub (handles Shade response; e.g., log or update state)
    #[private]
    pub fn on_key_generated(&mut self, group_id: String, checksum: String) {  // Args from Shade callback
        if let Some(mut group) = self.groups.get(&group_id) {
            group.shade_checksum = Some(checksum);  // Add field to Group: shade_checksum: Option<String>
            self.groups.insert(&group_id, &group);
        }
        log!("Updated group {} with Shade checksum: {}", group_id, checksum);
    }

    pub fn group_contains_key(&self, group_id: String) -> bool {
        self.groups.contains_key(&group_id)
    }

    #[payable]
    pub fn add_group_member(&mut self, group_id: String, user_id: AccountId) -> Promise {
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can add");
        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        assert!(!members.iter().any(|x| *x == user_id), "User already a member");
        members.push(user_id.clone());
        let shade_args = json!({ "group_id": group_id, "new_member": user_id.to_string() }).to_string().into_bytes();
        Promise::new(self.shade_contract_id.clone())
            .function_call(
                "update_member_access".to_string(),
                shade_args,
                1,  // Minimal deposit (1 yocto)
                300_000_000_000_000  // Gas
            );
        log!("Added {} to group {} (Shade access updated)", user_id, group_id);
    }

    #[payable]
    pub fn revoke_group_member(&mut self, group_id: String, user_id: AccountId) {
        let group = self.groups.get(&group_id).expect("Group not found");
        let caller = env::predecessor_account_id();
        assert_eq!(caller, group.owner, "Only group owner can revoke");
        let members = self.group_members.get_mut(&group_id).expect("Group not found");
        if let Some(pos) = members.iter().position(|x| x == &user_id) {
            members.swap_remove(pos.try_into().unwrap());
            let shade_contract = "ac-proxy.nova-shade-agent.testnet".parse::<AccountId>().expect("Invalid Shade contract ID");  // Update to ac-sandbox for Phala
            let rotation_args = json!({ "group_id": group_id.clone() }).to_string().into_bytes();
            let rotation_promise = Promise::new(shade_contract)
                .function_call(
                    "rotate_key".to_string(),  // Shade func to rotate
                    rotation_args,
                    0,  // No deposit
                    300_000_000_000_000  // Gas for rotation
                );
            rotation_promise;
            log!("Revoked {} from group {} (rotated key in Shade)", user_id, group_id);
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
        assert!(self.groups.contains_key(&group_id), "Group not found");
        assert!(self.is_authorized(group_id.clone(), user_id.clone()), "User not authorized");
        // removed owner only, now any caller in group can record
        let trans_id = hex::encode(env::sha256(&format!(
            "{}{}{}{}{}",
            group_id,
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
    pub fn approve_shade_code_hash(&mut self, code_hash: String) {
        let caller = env::predecessor_account_id();
        assert_eq!(caller, self.owner, "Only owner can approve code hash");
        self.shade_code_hash = Some(code_hash);
        log!("Approved Shade code hash: {}", code_hash);
    }

    pub fn register_shade_worker(&mut self, worker_id: AccountId, attestation: Vec<u8>) {
        let expected_hash = self.shade_code_hash.as_ref().expect("No code hash approved");
        // Simplified verify (in local ac-proxy: assume valid; prod: integrate phala-sdk for TEE quote)
        let checksum = hex::encode(env::sha256(&attestation));  // Stub: Hash attestation
        assert!(checksum.starts_with("0x"), "Invalid attestation format");  // Basic check
        self.workers.insert(worker_id.clone(), checksum);
        log!("Registered Shade worker: {} with checksum {}", worker_id, checksum);
    }

    pub fn get_access_token(&self, group_id: String, user_id: AccountId) -> String {
        assert!(self.is_authorized(group_id.clone(), user_id.clone()), "Unauthorized");
        let payload = json!({
            "group_id": group_id,
            "user_id": user_id.to_string(),
            "exp": env::block_timestamp() + 3_600_000_000_000u64  // 1h in ns
        }).to_string();
        let payload_bytes = payload.as_bytes();
        let hash = env::sha256(payload_bytes);
        // Stub sig (local: use env::random; prod: near-crypto::signer)
        let sig = hex::encode(env::random_seed()[0..64].to_vec());  // 64-byte dummy
        let token = format!("{}.{}", BASE64_STANDARD.encode(payload_bytes), sig);
        log!("Generated access token for {}/{}", group_id, user_id);
        token
    }

    // Private request_signature (guarded; for key ops only; omni stub)
    // Call via Shade API; restricts to nova_key_ paths
    pub fn request_signature(&self, path: String, payload: Vec<u8>, key_type: String) -> String {
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
    use near_sdk::{testing_env, AccountId};

    fn get_context(signer: AccountId) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder.signer_account_id(signer.clone());
        builder.predecessor_account_id(signer);
        builder
    }

    #[test]
    fn register_group_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        assert!(contract.groups.contains_key(&"test_group".to_string()));
    }

    #[test]
    #[should_panic(expected = "Only owner can register")]
    fn register_group_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let non_owner: AccountId = "not_owner.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        // Switch context to non_owner
        let context = get_context(non_owner);
        testing_env!(context.build());
        contract.register_group("test_group".to_string());
    }

    #[test]
    fn add_group_member_works() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());
        assert!(contract.is_authorized("test_group".to_string(), member));
    }

    #[test]
    #[should_panic(expected = "Only group owner can add")]
    fn add_group_member_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let non_owner: AccountId = "not_owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        contract.register_group("test_group".to_string());
        let context = get_context(non_owner);
        testing_env!(context.build());
        contract.add_group_member("test_group".to_string(), member);
    }

    #[test]
    fn revoke_group_member_works() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());
        contract.revoke_group_member("test_group".to_string(), member.clone());
        assert!(!contract.is_authorized("test_group".to_string(), member));
    }

    #[test]
    #[should_panic(expected = "User not a member")]
    fn revoke_group_member_fails_non_member() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        contract.register_group("test_group".to_string());
        contract.revoke_group_member("test_group".to_string(), member);
    }

    #[test]
    fn record_transaction_works() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());
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
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());

        // Switch to member context (non-owner)
        let context = get_context(member.clone());
        testing_env!(context.build());

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
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let non_member: AccountId = "non_member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.record_transaction(
            "test_group".to_string(),
            non_member,
            "file_hash".to_string(),
            "ipfs_hash".to_string(),
        );
    }

    #[test]
    fn get_transactions_for_group_works() {
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let member: AccountId = "member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
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
        let owner: AccountId = "owner.testnet".parse().expect("Invalid AccountId");
        let non_member: AccountId = "non_member.testnet".parse().expect("Invalid AccountId");
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.get_transactions_for_group("test_group".to_string(), non_member);
    }

    #[test]
    fn approve_shade_code_hash_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        contract.approve_shade_code_hash("dummy_hash".to_string());
        assert_eq!(contract.shade_code_hash, Some("dummy_hash".to_string()));
    }

    #[test]
    #[should_panic(expected = "Only owner can approve code hash")]
    fn approve_shade_code_hash_fails_non_owner() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_owner: AccountId = "non_owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        let context = get_context(non_owner);
        testing_env!(context.build());
        contract.approve_shade_code_hash("dummy_hash".to_string());
    }

    #[test]
    fn register_shade_worker_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.approve_shade_code_hash("dummy_hash".to_string());
        let worker: AccountId = "worker.testnet".parse().unwrap();
        let attestation = vec![0u8; 64];  // Dummy
        contract.register_shade_worker(worker.clone(), attestation);
        assert!(contract.workers.contains_key(&worker));
    }

    #[test]
    #[should_panic(expected = "No code hash approved")]
    fn register_shade_worker_fails_no_hash() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner);
        let worker: AccountId = "worker.testnet".parse().unwrap();
        let attestation = vec![0u8; 64];
        contract.register_shade_worker(worker, attestation);
    }

    #[test]
    fn get_access_token_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let member: AccountId = "member.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.add_group_member("test_group".to_string(), member.clone());
        let token = contract.get_access_token("test_group".to_string(), member.clone());
        assert!(!token.is_empty());
        assert!(token.contains("."));  // Payload + sig
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn get_access_token_fails_unauthorized() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let non_member: AccountId = "non_member.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let mut contract = Contract::new(owner.clone());
        contract.register_group("test_group".to_string());
        contract.get_access_token("test_group".to_string(), non_member);
    }

    #[test]
    fn request_signature_guarded_works() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let contract = Contract::new(owner);
        let sig = contract.request_signature("nova_key_test".to_string(), vec![0u8; 32], "Ecdsa".to_string());
        assert!(!sig.is_empty());  // Dummy hash
    }

    #[test]
    #[should_panic(expected = "Restricted path: key ops only")]
    fn request_signature_fails_invalid_path() {
        let owner: AccountId = "owner.testnet".parse().unwrap();
        let context = get_context(owner.clone());
        testing_env!(context.build());
        let contract = Contract::new(owner);
        contract.request_signature("invalid_path".to_string(), vec![0u8; 32], "Ecdsa".to_string());
    }
}
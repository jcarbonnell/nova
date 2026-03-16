// simple key-value contract for NOVA key management
use near_sdk::{env, near, AccountId, PanicOnDefault};
use near_sdk::store::IterableMap;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct KV {
    owner: AccountId,
    version: u32,
    allowed_code_hashes: Vec<String>,
    blobs: IterableMap<String, Vec<u8>>,
}

#[near]
impl KV {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            version: 1,
            allowed_code_hashes: Vec::new(),
            blobs: IterableMap::new(b"b"),
        }
    }

    // Owner can add TEE code hashes (multiple apps supported)
    pub fn add_code_hash(&mut self, code_hash: String) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "Owner only"
        );
        if !self.allowed_code_hashes.contains(&code_hash) {
            self.allowed_code_hashes.push(code_hash);
        }
    }

    // Write encrypted blob (only allowed callers)
    #[payable]
    pub fn store(&mut self, key: String, encrypted_blob: Vec<u8>) {
        let caller = env::predecessor_account_id().to_string();
        
        assert!(
            caller == self.owner.to_string() ||
            self.allowed_code_hashes.contains(&caller),
            "Unauthorized: caller {} not owner or allowed code hash",
            caller
        );

        self.blobs.insert(key, encrypted_blob);
    }

    // Read blob (view method)
    pub fn get(&self, key: String) -> Option<Vec<u8>> {
        self.blobs.get(&key).cloned()
    }

    // Debug helpers
    pub fn get_allowed_hashes(&self) -> Vec<String> {
        self.allowed_code_hashes.clone()
    }

    pub fn get_version(&self) -> u32 {
        self.version
    }

    // Safe migration if contract struct changes in the future
    pub fn migrate(&mut self) {
        assert_eq!(env::predecessor_account_id(), self.owner, "Only owner");
        assert_eq!(self.version, 1, "Already migrated");
        
        // Future migration logic goes here
        // Example: self.new_field = Default::default();
        
        self.version = 2;
        env::log_str("KV contract migrated to version 2");
    }
}
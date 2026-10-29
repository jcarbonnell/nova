#!/usr/bin/env python3
# mutate_v039.py: each mutant removes or weakens ONE v0.3.9 check; `cargo test --lib` must fail on every one.
# Run from contract/:  python3 mutate_v039.py
import shutil, subprocess, sys
SRC = 'src/lib.rs'
orig = open(SRC).read()
M = [
 ("file_hash length check dropped", "file_hash.len() == FILE_HASH_HEX_LEN && ", ""),
 ("file_hash length check weakened (>=)", "file_hash.len() == FILE_HASH_HEX_LEN", "file_hash.len() >= FILE_HASH_HEX_LEN"),
 ("file_hash hex check dropped", " && file_hash.bytes().all(|b| b.is_ascii_hexdigit())", ""),
 ("location cap dropped", " && location.len() <= MAX_LOCATION_BYTES", ""),
 ("location cap off by one (<)", "location.len() <= MAX_LOCATION_BYTES", "location.len() < MAX_LOCATION_BYTES"),
 ("empty location allowed", "!location.is_empty() && ", ""),
 ("file_hash check not called", "        assert_valid_file_hash(&file_hash);\n", ""),
 ("location check not called", "        assert_valid_location(&ipfs_hash);\n", ""),
 ("bounds checked after the fee", "        assert_valid_file_hash(&file_hash);\n        assert_valid_location(&ipfs_hash);\n        let attached = env::attached_deposit().as_yoctonear();\n        self.collect_fee(\"record_transaction\", attached);",
  "        let attached = env::attached_deposit().as_yoctonear();\n        self.collect_fee(\"record_transaction\", attached);\n        assert_valid_file_hash(&file_hash);\n        assert_valid_location(&ipfs_hash);"),
 ("checksum cap dropped", " && checksum.len() <= MAX_CHECKSUM_HEX_LEN", ""),
 ("empty checksum allowed", "!checksum.is_empty() && ", ""),
 ("nonce cap dropped", '        assert!(nonce.len() <= MAX_NONCE_BYTES, "Invalid nonce: at most 64 bytes");\n', ""),
 ("worker gate dropped", 'assert!(caller == self.owner || caller == self.shade_contract_id,\n            "Only owner or Shade contract can register workers");', "let _ = caller;"),
 ("worker gate opened to anyone", "caller == self.owner || caller == self.shade_contract_id", "true"),
]
caught = 0
try:
    for name, a, b in M:
        if orig.count(a) != 1:
            print(f"✗ {name}: anchor found {orig.count(a)} times"); sys.exit(2)
        open(SRC, 'w').write(orig.replace(a, b))
        r = subprocess.run(['cargo', 'test', '--lib', '-q'], capture_output=True, text=True)
        failed = r.returncode != 0
        first = next((l for l in r.stdout.splitlines() if l.startswith('test ') and 'FAILED' in l), '')
        print(f"{'✓ caught' if failed else '✗ SURVIVED'}  {name}  {first[5:80]}")
        caught += failed
finally:
    open(SRC, 'w').write(orig)
print(f"\n{caught}/{len(M)} mutants caught")
sys.exit(0 if caught == len(M) else 1)

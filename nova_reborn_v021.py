#!/usr/bin/env python3
"""nova-reborn v0.2.0 -> v0.2.1: point the extension at the nova-tee-2 MCP host.

Run from the nova repo root:  python3 nova_reborn_v021.py
Changes 4 files. Every anchor is counted first; if any count differs,
nothing is written.
"""
import pathlib
import sys

OLD_HOST = "5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network"
NEW_HOST = "7e9ff97d35e21fdd0f5c819472217d19e772d017-8000.dstack-base-prod5.phala.network"

# (file, old, new, expected count)
EDITS = [
    ("nova-reborn/manifest.toml", OLD_HOST, NEW_HOST, 18),  # 9 network_targets + 9 credential audiences
    ("nova-reborn/manifest.toml", 'version = "0.2.0"', 'version = "0.2.1"', 1),
    ("nova-reborn/src/lib.rs", OLD_HOST, NEW_HOST, 1),      # NOVA_MCP_BASE
    ("nova-reborn/Cargo.toml", 'version = "0.2.0"', 'version = "0.2.1"', 1),
    ("nova-reborn/Cargo.lock", 'name = "nova-reborn"\nversion = "0.2.0"',
     'name = "nova-reborn"\nversion = "0.2.1"', 1),
]

root = pathlib.Path.cwd()
texts = {}
problems = []
for f, old, new, n in EDITS:
    p = root / f
    if not p.is_file():
        problems.append(f"{f}: missing (run from the nova repo root)")
        continue
    texts.setdefault(f, p.read_text())
    c = texts[f].count(old)
    if c != n:
        problems.append(f"{f}: expected {n} x {old.splitlines()[-1]!r}, found {c}")
if problems:
    print("NOTHING WRITTEN:\n  " + "\n  ".join(problems))
    sys.exit(1)

for f, old, new, n in EDITS:
    texts[f] = texts[f].replace(old, new)

# Post-conditions, still before writing.
for f, t in texts.items():
    if OLD_HOST in t:
        print(f"NOTHING WRITTEN: {f} still names the old host"); sys.exit(1)
assert texts["nova-reborn/manifest.toml"].count(NEW_HOST) == 18
assert texts["nova-reborn/src/lib.rs"].count(NEW_HOST) == 1

for f, t in texts.items():
    (root / f).write_text(t)
    print(f"wrote {f}")
print("nova-reborn is now v0.2.1 on", NEW_HOST)

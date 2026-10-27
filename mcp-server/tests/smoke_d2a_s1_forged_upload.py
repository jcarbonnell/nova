# smoke_d2a_s1_forged_upload.py — D2 (A) production security smoke #1.
# A WALLET session must not get bytes written without a real, matching,
# on-chain record_transaction it signed itself.
#
#   read -rs NOVA_WALLET_SESSION && export NOVA_WALLET_SESSION
#   SMOKE_GROUP=<a group the wallet is a member of> python3 smoke_d2a_s1_forged_upload.py
#
# Spends nothing from the wallet and signs nothing as it. Side effect: ONE
# prepare_upload, which stores one wrapped file key in KV (signed by NOVA's
# KV signer) for a file that is never written: an orphan key, unreadable
# without bytes. A junk-token probe runs first (§10 order: security first).
import os
import random

from smoke_d2a_common import Checks, MCP_URL, load_session, tool

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
print(f"\nD2A S1 forged-upload smoke — MCP={MCP_URL}")
token, account = load_session()
c = Checks()

# 0. A junk bearer is rejected outright.
s, b = tool("prepare_upload", {"group_id": "x", "filename": "x"}, "junk.junk.junk", account)
c.true("junk session rejected (401)", s == 401, f"[{s}]")

group = os.environ.get("SMOKE_GROUP", "")
if not group:
    s, b = tool("get_member_groups", {}, token, account)
    groups = b.get("result") or []
    group = groups[0] if groups else ""
    print(f"  member groups: {groups[:5]}")
if not group:
    c.true("wallet is a member of some group (needed for prepare_upload)", False,
           "join or be added to a group, or set SMOKE_GROUP")
    c.done("D2A S1")

# 1. prepare_upload is now allowed for wallets and returns the location.
s, b = tool("prepare_upload", {"group_id": group, "filename": "d2a-s1-smoke.bin"}, token, account)
prep = b.get("result") or {}
loc = prep.get("location", "")
c.true("prepare_upload returns a FastFS location", s == 200 and "/" in loc and bool(prep.get("upload_id")),
       f"[{s}] {str(b.get('error', ''))[:120]}")
if not prep.get("upload_id"):
    c.done("D2A S1")
uid = prep["upload_id"]
fake_body = {"upload_id": uid, "encrypted_data": "AAAA", "file_hash": "ab" * 32, "format": None}

# 2. No tx_hash → refused.
s, b = tool("finalize_upload", fake_body, token, account)
c.refused("finalize without tx_hash refused", s, b, "need tx_hash")

# 3. Malformed tx_hash → refused before any chain lookup.
s, b = tool("finalize_upload", {**fake_body, "tx_hash": "not-a-hash!"}, token, account)
c.refused("finalize with malformed tx_hash refused", s, b, "not a valid transaction hash")

# 4. Well-formed but forged tx_hash → chain lookup fails → refused.
forged = "".join(random.choice(B58) for _ in range(44))
s, b = tool("finalize_upload", {**fake_body, "tx_hash": forged}, token, account)
c.refused("finalize with forged tx_hash refused", s, b, "tx lookup failed")

# 5. The upload was not consumed by the refusals (still pending), i.e. nothing
#    was written: a refused finalize must leave the slot untouched, and the
#    only way to consume it is a successful write.
s, b = tool("finalize_upload", {**fake_body, "tx_hash": forged}, token, account)
c.refused("upload still pending after refusals (not consumed / not written)", s, b, "tx lookup failed")

# 6. And nothing is retrievable at the issued location.
s, b = tool("prepare_retrieve", {"group_id": group, "ipfs_hash": loc}, token, account)
c.true("no bytes at the issued location", s >= 400 and "result" not in b,
       f"[{s}] {str(b.get('error', ''))[:120]}")

c.done("D2A S1")

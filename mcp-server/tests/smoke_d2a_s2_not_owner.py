# smoke_d2a_s2_not_owner.py — D2 (A) production security smoke #2.
# A WALLET session must get NO owner-side effect (key creation, key rotation,
# retention registry, window clear) on a group it does not own on chain.
#
#   read -rs NOVA_WALLET_SESSION && export NOVA_WALLET_SESSION
#   SMOKE_FOREIGN_GROUP=engine-test-evt python3 smoke_d2a_s2_not_owner.py
#
# The group must exist and be owned by SOMEONE ELSE (checked first, on chain).
# Read-only on chain; spends nothing. Each refusal waits ~15 s (MCP polls the
# chain before refusing), so the run takes about a minute.
import os

from smoke_d2a_common import Checks, MCP_URL, load_session, tool, view

print(f"\nD2A S2 not-owner smoke — MCP={MCP_URL}")
token, account = load_session()
c = Checks()

group = os.environ.get("SMOKE_FOREIGN_GROUP", "engine-test-evt")
owner = view("get_group_owner", {"group_id": group})
c.true(f"precondition: '{group}' exists and is owned by someone else", bool(owner) and owner != account,
       f"owner={owner}")
if not owner or owner == account:
    c.done("D2A S2")

victim = owner  # any account id works as the member target; use the owner (always present)
retention_before = view("get_group_retention", {"group_id": group})

s, b = tool("register_group", {"group_id": group}, token, account)
c.refused("register_group (key creation) refused", s, b, "not owned on chain")

s, b = tool("revoke_group_member", {"group_id": group, "member_id": victim}, token, account)
c.refused("revoke_group_member (key rotation) refused", s, b, "not owned on chain")

s, b = tool("set_group_retention", {"group_id": group, "retention_days": 1}, token, account)
c.refused("set_group_retention (registry write) refused", s, b, "not owned on chain")

s, b = tool("add_group_member", {"group_id": group, "member_id": victim}, token, account)
c.refused("add_group_member (window clear) refused", s, b, "not owned on chain")

s, b = tool("get_member_window", {"group_id": group, "member_id": victim}, token, account)
c.refused("get_member_window (owner read) refused", s, b, "only the group owner")

s, b = tool("join_group", {"group_id": group}, token, account)
c.refused("join_group via MCP refused for wallets", s, b, "own wallet")

# The retention attempt must not have changed the on-chain window either.
retention_after = view("get_group_retention", {"group_id": group})
c.true("on-chain retention unchanged by the attempt", retention_after == retention_before,
       f"before={retention_before} after={retention_after}")

c.done("D2A S2")

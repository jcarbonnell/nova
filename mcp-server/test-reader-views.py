# mcp-server/test_reader_views.py
#
# Standalone harness for the owner-gated reader-view path (§5.0 wallet reads).
# Proves, against the REAL deployed contract + the REAL reader FC key:
#   1. read_owner_gated_view signs as nova-sdk.near and the FastNear patch covers it
#      (a 403 here = the §7 Bearer-collision bug reaching the reader path).
#   2. get_owned_groups_of returns the known groups for nova-sdk.near.
#   3. get_member_groups_of returns its known (superset) list.
#   4. the two handlers, called with a wallet-subject user dict, reach the view
#      and return data WITHOUT a custodial key (the whole point).
#
# REQUIRES in env (never committed): READER_PRIVATE_KEY, FASTNEAR_API_KEY,
# CONTRACT_ID=nova-sdk.near, RPC_URL (the FastNear mainnet URL).
# Run:  READER_PRIVATE_KEY=ed25519:... FASTNEAR_API_KEY=... \
#       CONTRACT_ID=nova-sdk.near RPC_URL=https://... python test_reader_views.py
#
# Submits REAL mainnet txs signed by the reader key (gas from its 5 NEAR
# allowance). Read-only on data; costs only gas.

import asyncio
import os
import sys

# Import the REAL shipped functions (not a copy).
from server import (
    read_owner_gated_view,
    get_reader_signer,
    get_owned_groups,
    get_member_groups,
    READER_PRIVATE_KEY,
)

# Known ground truth from the live contract (verified via near call earlier):
#   get_owned_groups_of(nova-sdk.near)  -> test-shade-group, mcp-test-group, smoke-test-joinable
#   get_member_groups_of(nova-sdk.near) -> + delete-hono-test  (superset)
OWNER_ACCT = "nova-sdk.near"
EXPECTED_OWNED = {"test-shade-group", "mcp-test-group", "smoke-test-joinable"}
EXPECTED_MEMBER_SUPERSET = EXPECTED_OWNED | {"delete-hono-test"}

passed = 0
failed = 0

def check(name, cond):
    global passed, failed
    if cond:
        print(f"  ✅ {name}")
        passed += 1
    else:
        print(f"  ❌ {name}")
        failed += 1


async def main():
    if not READER_PRIVATE_KEY:
        print("FATAL: READER_PRIVATE_KEY not set — cannot test the reader path.")
        sys.exit(1)

    print("1. Reader signer builds + FastNear patch covers it")
    try:
        acc = await get_reader_signer()
        check("get_reader_signer() returns a started Account", acc is not None)
    except Exception as e:
        # A 403 here is the §7 Bearer collision reaching the reader path.
        check(f"get_reader_signer() (no 403 / auth error): {e}", False)
        print("\nAborting — signer construction failed.")
        sys.exit(1)

    print("2. get_owned_groups_of via read_owner_gated_view")
    owned = await read_owner_gated_view("get_owned_groups_of", OWNER_ACCT)
    print(f"     returned: {owned}")
    check("returns a list", isinstance(owned, list))
    check("contains the known owned groups",
          EXPECTED_OWNED.issubset(set(owned)))

    print("3. get_member_groups_of via read_owner_gated_view")
    member = await read_owner_gated_view("get_member_groups_of", OWNER_ACCT)
    print(f"     returned: {member}")
    check("returns a list", isinstance(member, list))
    check("contains the known member groups (superset of owned)",
          EXPECTED_MEMBER_SUPERSET.issubset(set(member)))
    check("member is a superset of owned", set(owned).issubset(set(member)))

    print("4. Handlers work for a WALLET-subject session (no custodial key)")
    # A wallet user: near_account_id is their own wallet, no email/wallet_id
    # custodial key in Shade. The handler must NOT touch get_user_signer.
    wallet_user = {
        "near_account_id": OWNER_ACCT,  # use nova-sdk.near as the queried acct
        "email": None,
        "wallet_id": None,
        "access_token": None,
        "session_token": "harness",
    }
    # Handlers are decorated (@expose_as_rest/@require_auth). Call the underlying
    # coroutine with ctx=None, user=wallet_user — mirroring how the REST wrapper
    # invokes them (original_func(None, user, ...)).
    try:
        owned_h = await get_owned_groups(None, wallet_user)
        print(f"     get_owned_groups -> {owned_h}")
        check("wallet-subject get_owned_groups returns known groups",
              EXPECTED_OWNED.issubset(set(owned_h)))
    except Exception as e:
        check(f"wallet-subject get_owned_groups (no signer 501): {e}", False)

    try:
        member_h = await get_member_groups(None, wallet_user)
        print(f"     get_member_groups -> {member_h}")
        check("wallet-subject get_member_groups returns known groups",
              EXPECTED_MEMBER_SUPERSET.issubset(set(member_h)))
    except Exception as e:
        check(f"wallet-subject get_member_groups (no signer 501): {e}", False)

    print(f"\n{'='*50}")
    print(f"  {passed} passed, {failed} failed")
    print(f"{'='*50}")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())
# mcp-server/guards.py
#
# MCP v47 guards (roadmap §5.12, MCP v47). Pure logic with injected I/O, so the
# harness runs offline without py_near, fastmcp or any environment.
#
#   6a FreeBalanceFloor — before MCP signs as nova-sdk.near (the reader views),
#      it checks that nova-sdk.near keeps at least FREE_BALANCE_FLOOR_YOCTO of
#      AVAILABLE balance (total minus storage-locked). Below it, nothing is
#      signed. The function-call key's allowance caps what that KEY can spend;
#      the floor protects what the CONTRACT needs free for its own storage
#      (roadmap §9 2026-10-29, "slow storage drain"), whatever any key does.
#      Fails CLOSED: if the balance cannot be read, nothing is signed.
#
# Constants live here, not in env vars: a new variable means a compose change,
# and under onchain KMS every compose change is an addComposeHash transaction.
#
# 6b (RateLimiter, VerifiedKeyCache) and 6c (ContractRefusal, rest_status) are below.
#
# Harness: test-mcp-v047-guards.py.

import hashlib
import json
import re
import time
from collections import deque

YOCTO_PER_NEAR = 10**24
STORAGE_YOCTO_PER_BYTE = 10**19          # NEAR storage price: 1 NEAR per 100 kB
FREE_BALANCE_FLOOR_YOCTO = 5 * 10**23    # 0.5 NEAR
BALANCE_CACHE_SECONDS = 60


class GuardRefusal(Exception):
    """A guard refused the operation. `status` is the HTTP status it maps to."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class FreeBalanceFloor:
    """`fetch_account(account_id)` is an async callable returning NEAR's
    view_account result: a dict with "amount" (yocto, string) and
    "storage_usage" (bytes). Successful reads are cached for `ttl` seconds per
    account; failures are never cached."""

    def __init__(self, fetch_account, floor_yocto: int = FREE_BALANCE_FLOOR_YOCTO,
                 ttl: float = BALANCE_CACHE_SECONDS, clock=time.monotonic):
        self._fetch = fetch_account
        self._floor = floor_yocto
        self._ttl = ttl
        self._clock = clock
        self._cache: dict[str, tuple[float, int]] = {}

    async def available(self, account_id: str) -> int:
        now = self._clock()
        hit = self._cache.get(account_id)
        if hit and hit[0] > now:
            return hit[1]
        try:
            acc = await self._fetch(account_id)
            avail = int(acc["amount"]) - int(acc["storage_usage"]) * STORAGE_YOCTO_PER_BYTE
        except Exception as e:  # any failure: refuse, never assume the balance is fine
            raise GuardRefusal(503, f"balance check for {account_id} failed ({type(e).__name__}); "
                                    "refusing to sign. Try again later.") from e
        self._cache[account_id] = (now + self._ttl, avail)
        return avail

    async def require(self, account_id: str) -> None:
        if await self.available(account_id) < self._floor:
            raise GuardRefusal(503, f"{account_id} free balance is below the safety floor "
                                    f"({self._floor / YOCTO_PER_NEAR:g} NEAR); refusing to sign. "
                                    "Try again later.")


#   6b RateLimiter — at most READER_VIEWS_PER_MINUTE signed reader views per
#      session account per sliding minute; beyond that, 429 and nothing signed.
#      Each signed view costs nova-sdk.near gas, so this caps what one account
#      can make NOVA spend. Checked BEFORE the balance read (no RPC spent).

READER_VIEWS_PER_MINUTE = 10
RATE_WINDOW_SECONDS = 60
_MAX_TRACKED = 10_000      # above this, stale entries are swept (bounded memory)


class RateLimiter:
    def __init__(self, limit: int = READER_VIEWS_PER_MINUTE, window: float = RATE_WINDOW_SECONDS,
                 clock=time.monotonic):
        self._limit = limit
        self._window = window
        self._clock = clock
        self._hits: dict[str, deque] = {}

    def hit(self, key: str) -> None:
        now = self._clock()
        if len(self._hits) > _MAX_TRACKED:
            self._hits = {k: q for k, q in self._hits.items() if q and q[-1] > now - self._window}
        q = self._hits.setdefault(key, deque())
        while q and q[0] <= now - self._window:
            q.popleft()
        if len(q) >= self._limit:
            raise GuardRefusal(429, f"too many signed views for this account ({self._limit} per "
                                    f"{self._window:g} s); try again shortly.")
        q.append(now)


#   6b VerifiedKeyCache — a SUCCESSFUL Shade verify-api-key answer is cached
#      for API_KEY_CACHE_SECONDS, keyed by sha256(key + account): the raw key is
#      never kept. A refused or failed verification is NEVER cached, so a revoked
#      key stops working within API_KEY_CACHE_SECONDS at most (operator decision,
#      2026-11-11). Roadmap §9 2026-10-14 (DoS amplification via verify-api-key).

API_KEY_CACHE_SECONDS = 60


class VerifiedKeyCache:
    def __init__(self, ttl: float = API_KEY_CACHE_SECONDS, clock=time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, float] = {}

    @staticmethod
    def _id(api_key: str, account_id: str) -> str:
        return hashlib.sha256(f"{api_key}\x00{account_id}".encode()).hexdigest()

    def is_verified(self, api_key: str, account_id: str) -> bool:
        exp = self._entries.get(self._id(api_key, account_id))
        if exp is None:
            return False
        if exp <= self._clock():
            self._entries.pop(self._id(api_key, account_id), None)
            return False
        return True

    def remember(self, api_key: str, account_id: str) -> None:
        now = self._clock()
        if len(self._entries) > _MAX_TRACKED:
            self._entries = {k: e for k, e in self._entries.items() if e > now}
        self._entries[self._id(api_key, account_id)] = now + self._ttl


#   6c Clean errors — contract refusals and HTTP statuses (roadmap §9 2026-10-27:
#      "MCP returns 500 for refusals"; 2026-10-28: "MCP returns raw contract
#      errors"). A contract panic becomes a ContractRefusal carrying the
#      contract's own sentence (no ActionError wrapper) and a status from the
#      contract's actual messages; any other transaction failure is a 502 with
#      no raw details. ContractRefusal subclasses RuntimeError, so existing
#      callers that catch RuntimeError keep working.

_PANIC = re.compile(r"Smart contract panicked: ([^\"\\]+)")

_FORBIDDEN = ("Unauthorized", "Only ", "User not authorized", "User not a member",
              "Invalid signature on payload", "Nonce already used", "Token timestamp",
              "Group is not joinable")
_CONFLICT = ("Group exists", "Already a member", "User already a member",
             "Join window closed", "Join window full", "Group not open for join")


class ContractRefusal(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def contract_failure(failure) -> ContractRefusal:
    """Map a NEAR transaction `Failure` (dict or string) to a ContractRefusal."""
    text = failure if isinstance(failure, str) else json.dumps(failure)
    m = _PANIC.search(text)
    if not m:
        return ContractRefusal(502, "The NEAR transaction failed; please try again.")
    msg = m.group(1).strip()
    if msg.startswith(_FORBIDDEN):
        return ContractRefusal(403, msg)
    if msg.endswith("not found"):
        return ContractRefusal(404, msg)
    if msg.startswith(_CONFLICT):
        return ContractRefusal(409, msg)
    return ContractRefusal(400, msg)


def rest_status(e: Exception) -> int:
    """HTTP status for an exception raised by a tool behind a REST route."""
    status = getattr(e, "status", None)
    if isinstance(e, (GuardRefusal, ContractRefusal)) and isinstance(status, int):
        return status
    if isinstance(e, PermissionError):
        return 403
    if isinstance(e, ValueError):
        return 400
    return 500

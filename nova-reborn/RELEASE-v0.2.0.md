# nova-reborn v0.2.0

IronClaw Reborn extension (`near:agent@0.4.1`) exposing NOVA as nine tools.
Successor to nova-submit (0.3.0), which cannot load on Reborn 1.4.1.

**Zip sha256:** `ca6a6fa4970bb2289a5af52eff62738e86c57191df83aa6ddbabb36d853a1307`
**Validated against:** ironclaw-v1.4.1 (b011eb39) `imported_extension_package`.

## Tools (ids stable: `nova.<method>`)
- Agent: `store_file`, `retrieve_file`, `list_group_files`, `list_owned_groups`,
  `list_member_groups`, `join_group`
- Owner: `register_group` (~0.65 NEAR), `add_group_member`, `revoke_group_member`

## Auth
The NOVA credential is host-injected as `X-API-Key` on every request to the NOVA
MCP host; the guest never holds it. Each call names its account in
`account_id` / `x-account-id`; the MCP verifies the pair with NOVA's TEE and
fails closed. Requires NOVA MCP v38+.

## Limits and identification
- Max `store_file` content: **1 MiB** (UTF-8 text).
- Max decoded `retrieve_file` size: **8 MiB**.
- Network: every output carries `network` (`testnet` if the account id contains
  `.testnet`, else `mainnet`, the same rule the MCP uses).

## Deviations from nova-tool-interface.md
- `store_file`'s four §5 codes are exact. Additional codes: `content_too_large`,
  `bad_input`, `not_utf8` (kind input); `not_owner`, `already_member`,
  `join_refused` (kind client); `operation_failed` (generic, non-store tools).
- Wire format is v0 (no `format` metadata sent); `retrieve_file` decodes v0 and v1
  (incl. deflate).
- `store_file` retries once if the host declines to send a request
  (`request_sent=false`, e.g. an outbound-scanner false positive on random
  ciphertext). No retry once a request was sent.
- `join_group` output: `joined: true` means the account **is a member now**
  (post-condition); `already_member` says whether it was a member before the call
  (`true` → no join call was made, no fee).

## Known limitations
- `retrieve_file` (utf8): if the plaintext contains a host sensitive-marker word,
  the host drops the observation; use `encoding: "base64"`.
- A stored ciphertext that matches a host scanner pattern by chance (~1 in 7,000
  for a 5 KB file) is blocked on every retrieve.
- `list_owned_groups` / `list_member_groups` on testnet use the caller-signed read
  (0.0001 NEAR fee); fee-free reader views are mainnet-only for now.

## Upgrade
In-place upgrade is not supported by the host: remove → restart the agent →
import → install → setup → policy. Per-tool policy persists across reinstall.
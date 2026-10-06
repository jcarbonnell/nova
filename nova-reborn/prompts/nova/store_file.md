# nova.store_file

Encrypt a UTF-8 text file with AES-256-GCM and upload it to a NOVA group on NEAR,
under your own NOVA account. The encryption happens inside the tool — you never
handle keys, nonces, or ciphertext.

Use this to contribute a file (e.g. a JSON graph) to a group you already belong
to. The tool does **not** join groups: if your account is not a member of
`group_id`, the call fails with `not_member`.

Before anything else, the tool verifies that `content` hashes to the `sha256` you
provide; if they differ it fails immediately with `hash_mismatch` and sends no
network request. Compute `sha256` as the SHA-256 of the UTF-8 bytes of `content`.

Parameters:
- `account_id` — your NOVA account (must match the configured API key).
- `group_id` — a group you are already a member of.
- `filename` — the name to record for the upload.
- `content` — the full UTF-8 text to store.
- `sha256` — 64 hex chars, SHA-256 of the content bytes.

On success the tool returns the storage `cid`, the NEAR `trans_id`, and the
on-chain `file_hash` (the SHA-256 of the plaintext, which equals your `sha256`).

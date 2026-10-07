# nova.retrieve_file

Retrieve and decrypt a file from a NOVA group you belong to. Decryption happens
inside the tool. Pass the file's `cid` (from `store_file` or `list_group_files`).

Use `encoding: "base64"` for binary files; the default `utf8` returns text and
fails with `not_utf8` if the file is not valid UTF-8.

Returns `content`, its `sha256` (compare it with the `file_hash` that
`list_group_files` reports to confirm integrity), `size_bytes`, and `network`.
Fails with `not_member` if your account is not in the group.
# nova.list_group_files

List the files recorded in a NOVA group: uploader (`user_id`), `file_hash`
(SHA-256 of the plaintext), storage location (`cid`), `timestamp`, and
`deleted` (a deletion record if the file was removed, otherwise null).

Free on open groups; a small NEAR read fee applies on private groups, where your
account must be a member.
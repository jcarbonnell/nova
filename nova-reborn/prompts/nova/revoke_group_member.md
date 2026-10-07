# nova.revoke_group_member

Remove a member from a NOVA group your account owns, and rotate the group's
encryption key so the removed member cannot read files uploaded afterwards.
Costs a small NEAR fee. Fails with `not_owner` if your account does not own the
group.
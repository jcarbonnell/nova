# nova.join_group

Join an open NOVA group: one whose owner opened a join window. Costs a small
NEAR fee. If you are already a member it checks first and succeeds with
`already_member: true` without calling the join (no fee).

Fails with `join_refused` if the group is not open for joining or its window is
closed or full.
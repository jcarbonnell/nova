# Epic 001: Tech Debt & Auth Modernization

### Context

The current auth system couples the agency API to env-based DAO resolution, on-chain Sputnik role checks, and cookie-based NEAR account resolution via cross-service HTTP fetch. A local projects plugin at `plugins/projects/` introduces new `kind` values (`scope`, `result`), a global slug constraint, mention linking, and a refined context shape (`walletAddress`, `user.role`). This epic removes the env/DAO coupling, adopts standard better-auth organizations for identity and role gating, aligns the API with the new projects plugin contract, and sets up continuous deployment via GitHub Actions and Railway.

API routes currently wrapped by env-derived `orgAccountId` and DAO-based `gates` will gate on better-auth organization membership and roles instead. Three better-auth org roles control page/API access: `admin` (full CRUD), `contributor` (read-only admin), and `client` (read-only portal, added in #003-07). The Sputnik DAO integration remains for treasury/team display queries but is no longer the auth layer — `userInRole()` stays as a utility in `sputnik.ts` but is never called during request gating.

### Tickets

| # | Ticket | Dependency |
|---|--------|------------|
| 001-01 | Replace env-based auth with better-auth orgs, roles, and session identity | — |
| 001-02 | Align API with new projects plugin | 001-01 |
| 001-03 | Continuous deployment pipeline via GitHub Actions and Railway | 001-02 |

### Acceptance Criteria

- [ ] `AGENCY_ORG_ACCOUNT_*` env vars are no longer required for auth
- [ ] Organization identity comes from the active better-auth organization on the session
- [ ] Role gating uses `requireOrganization` + `requireRole` from `api/src/lib/auth.ts`
- [ ] No HTTP fetch to `/api/auth/near/list-accounts` in request path
- [ ] No Sputnik DAO RPC call during auth gating
- [ ] `proxyCtx` passes proper `organizationId` and `user.role` to the projects plugin
- [ ] New project kinds (`scope`, `result`) are supported in agency API
- [ ] CI/CD pipeline: GitHub Actions CI passes, Railway deploys successfully
- [ ] All existing admin functionality works under new auth model
- [ ] `bun typecheck` and `bun lint` pass

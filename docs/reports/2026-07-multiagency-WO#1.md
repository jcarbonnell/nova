# Julien Carbonnell (CivicTech OU) — IronClaw Hackathon Deployment Engine: Self-Service Backend & Organizer One-Call Deploy

**Reporting period:** July 15 – August 15, 2026
**Contributor:** Julien Carbonnell (CivicTech OU)
**NEAR wallet:** nova-sdk.near
**Attached to:** MultiAgency Work Order #1
**IP model:** Open-source contribution (MIT)

---

## Summary

Work Order #1 scopes the **one-click hackathon deployment engine** — turning the manually-run Barcelona pipeline into a self-serve product any organizer can deploy. That scope splits cleanly into two halves:

- **The backend half — DELIVERED and mainnet-verified this period.** Everything that makes the engine self-serve at the protocol/API level: on-chain self-service join (removing the manual relay that broke the Barcelona funnel), the organizer one-call event-deploy primitive, deadline-triggered automated judging, public event browsability, and the typed-API + hardening substrate that makes the engine an integration-ready surface. All in production on NEAR mainnet, verified end-to-end 2026-07-29.
- **The frontend half — ARCHITECTED and HANDED OFF, pending (not NOVA-side).** The deployment-engine UI, the public event/project landing pages, and the Launchpad intake bridge live in the NEARBuilders interface (`ironclaw.nearbuilders.org`) and are Elliot's build, per the standing "ping when the backend is ready" handoff. The backend they consume is live; the handoff note is written.

This report maps each Work Order #1 deliverable to its real, roadmap-confirmed status, then details the delivered work. Consistent with that split, the compensation request is **500 NEAR against the 1,000 NEAR maximum asked for the full job** for the delivered backend half.

The honest through-line: Work Order #0 reported the engine's mainnet debut at Barcelona but **only 1 formal submission from ~70 active participants** — a disappointing failure whose worst offender was the manual step of relaying a NOVA account ID to staff for group inclusion. This period removed that step at the production level and shipped the self-service backend around it.

---

## Deliverable status — Work Order #1, mapped to what shipped

| # | Deliverable (WO#1) | Status |
|---|---|---|
| 2 | Automated participant member-management (programmatic admission, no manual relay) | ✅ **Delivered** — shipped as on-chain **self-service join** (contract v0.3.2, mainnet 2026-07-27). Stronger than "the organizer adds groups members on request": the participant self-joins, so no organizer action is needed mid-event at all. |
| 3 | Deadline-triggered automated judging / collection | ✅ **Delivered** (engine side) — `judge.mjs` collects via the on-chain log + public views, decrypts, integrity-checks; Barcelona-proven and re-verified through the new loop. Becomes a scheduled job on nearbuilders infra with a one-line change (local-file write → DB write) when the frontend lands. |
| 6 | Typed API surface (oRPC + published OpenAPI) + enabling platform hardening | ✅ **Delivered** — public oRPC contract + publishable typed client shipped; supporting hardening (API-key rotation §5.9, public view twins §5.6, dependency pinning, dead-code sweep) in production. This is the integration surface the NEARBuilders interface consumes. |
| 7 | Documentation for organizers and participants | ✅ **Delivered** (engine side) — the `ironclaw-hackathon` skill + judge READMEs updated for the self-join flow; event-agnostic. |
| 1 | Self-serve event-deployment flow (organizer form → group + public page) | ◑ **Backend delivered, frontend handed off.** The one-call backend primitive (`create_hackathon_group`) is live and mainnet-verified; the organizer-facing form + public landing page are Elliot's frontend (`ironclaw.nearbuilders.org`), pending. |
| 4 | Public event landing pages + event-tagged project rendering | ○ **Handed off to Elliot** — NEARBuilders interface; the public-read backend (joinable-gated view twins) that these pages consume is live. |
| 5 | Launchpad intake bridge in the NEARBuilders interface | ○ **Handed off to Elliot** — integration into the NEARBuilders UI against the existing Launchpad intake; not NOVA-side. |

Delivered work detailed below.

---

## 1 · Self-service group join — the Barcelona funnel fix (Deliverable 2)

**The problem it solves.** At Barcelona, a participant who wanted to submit had to send their NOVA account ID to staff, wait to be added to the on-chain submission group, and only then submit. That manual round-trip, during a time-boxed hackathon, is where the ~70→1 drop-off happened. Work Order #0's explicit recommendation was to automate it; Work Order #1 §6.2 scopes it as "programmatic admission … removing the human relay."

**What shipped — contract v0.3.2 (mainnet, 2026-07-27), stronger than scoped.** Rather than have the organizer admit participants programmatically (still an organizer action), the participant now **self-joins**: `join_group(group_id)` joins an opened event group for ~0.001 NEAR, with no organizer action mid-event. The design is an **open join window, not an invite code** — `open_hackathon_join(group_id, expires_at, max_uses)` (owner-only) opens the window; `join_group` lets anyone self-join until it expires. A code was rejected deliberately: it would sit in world-readable contract state and be printed on the public event page anyway, so `expires_at` is the real control.

**Structurally gated so it can't leak.** Only groups registered `joinable=true` can be opened for self-join; private groups (clinical, B2B) can never be self-joined — enforced at the contract level, not by convention. The state upgrade shipped via `migrate()` with zero data loss; the Barcelona group was verified intact after the upgrade. Full happy path confirmed on live mainnet.

---

## 2 · Organizer one-call event deploy + the full loop across every layer (Deliverables 1-backend, 3, 6, 7)

This period made the engine **clonable by any city node** at the backend level — no bespoke setup, no me in the loop. The whole organizer→participant→submit path was re-shipped, in sequence, across every layer of the stack.

**`create_hackathon_group` — the organizer's one-call "deploy event" primitive (MCP v0.4.3).** A single call registers the group as joinable, generates its Shade encryption key, and opens the join window server-side — the three steps an organizer previously had to coordinate, folded into one. (The generate-key step was a latent bug caught during the build: a group created without it would authorize joiners but leave them keyless.) The organizer also gets `close_hackathon_join` for manual early-close. This is the backend of Deliverable 1; the organizer-facing form that calls it is Elliot's frontend.

**Shipped in sequence, each layer mainnet-verified:**

- **Contract v0.3.2** — `join_group`, `open_hackathon_join` / `close_hackathon_join`, the `joinable` flag, `migrate()`. Mainnet 2026-07-27.
- **API-key rotation (§5.9, Shade v50)** — rotation now genuinely invalidates the old key (versioned derivation), verified on mainnet, with a frontend rotate control. This makes the hackathon READMEs' "rotate your key after the event" instruction actually honest — a real security property for events that hand out credentials, and part of the "integration-ready surface" of Deliverable 6.
- **MCP v0.4.3** — `create_hackathon_group` (the one-call deploy), `join_group`, `close_hackathon_join`.
- **Both SDKs v1.1.1** — `joinGroup` in `nova-sdk-js` (npm) and `nova-sdk-rs` (crates.io), so any developer participant integrates self-join in their own language.
- **`ironclaw-hackathon` skill v0.4.0** — a single self-join-then-submit flow, no staff relay. The event-specific group ID stays an abstracted parameter, so the same skill works across every event (Deliverable 7).
  - Repo: https://github.com/jcarbonnell/ironclaw-hackathon
  - Skill: https://github.com/jcarbonnell/ironclaw-hackathon/tree/main/skill
  - Organizer / judge side: https://github.com/jcarbonnell/ironclaw-hackathon/tree/main/judge
- **`nova-submit` tool v0.2.0** — self-join + a manifest guard: submissions are manifests (title, description, repo URL, video URL, team, track), never bundled payloads, keeping every submission well under the storage cap and the engine forward-compatible with the v1.0 storage migration.
  - Release: https://github.com/jcarbonnell/nova/releases/tag/nova-submit-v0.2.0

**Public browsability — contract public view twins (v0.3.3, mainnet 2026-07-30, Deliverable 6 / backend of 4).** Two joinable-gated public views (`get_group_members_public`, `get_transactions_for_group_public`) let anyone read an open event's members and submissions for free, unsigned — while private-group metadata stays confidential (signed reads only). This is the read-backend the public event/project pages (Deliverable 4, Elliot's) will consume; the MCP read tools were flipped and smoke-checked live.

**The full loop is mainnet-verified (2026-07-29):** organizer deploys an event in one call → participant self-joins → receives the group key → encrypts and submits via `nova-submit` → the submission is recorded on-chain (the timestamp *is* the deadline proof) → the organizer's `judge.mjs` collects every submission via the public view, decrypts, and integrity-checks each against its on-chain hash (Deliverable 3).

**Typed API surface (Deliverable 6).** The public wire protocol is described as a standalone oRPC contract with a generated OpenAPI spec and a publishable typed client — the interface through which the NEARBuilders surfaces consume the engine, and the concrete outcome of the ecosystem convergence agreed with the NEARBuilders team. A build-time guard fails if any private-key field ever appears in the public spec.

**Ecosystem integration in progress (not NOVA-side).** The updated `nova-submit` v0.2.0 is filed for inclusion in ironhub so it ships by default to every IronClaw user:

- Issue: https://github.com/nearai/ironhub/issues/249
- Repo: https://github.com/nearai/ironhub

Until the PR merges, agents install the tool from the GitHub release above.

---

## 3 · The frontend half — architected, handed off, pending (Deliverables 1-UI, 4, 5)

Giving authority to what actually shipped: the deployment-engine UI, the public event/project landing pages, and the Launchpad intake bridge are **not NOVA-side and were not built this period.** They live in the NEARBuilders interface (`ironclaw.nearbuilders.org`) and are Elliot's build, per the standing "ping when the backend is ready" handoff. What this period delivered is the **backend those surfaces consume, now live**: the one-call deploy primitive (behind Deliverable 1's form), the joinable-gated public views (behind Deliverable 4's pages), and the manifest-shaped submissions carrying the repo URL (the payload Deliverable 5's Launchpad bridge routes). The architecture of all three — the event abstraction, the decrypt-at-deadline → project-set contract, and the Launchpad intake bridge — was designed in the two companion notes from the prior period and is unblocked on the backend side.

The `judge.mjs` judging job becomes a scheduled job on nearbuilders infrastructure with a one-line change (local-file write → DB write) when the frontend lands.

---

## Assessment — how this supports the project, client, and ecosystem

**Ecosystem objective.** NEAR Foundation's goal for IronClaw is a growing catalog of open-source skills and tools built by the dev community, with the NEAR Legion city-node hackathon series as the contribution funnel. Work Order #0 delivered the *mechanism*; this period made it **self-service at the backend level** — the property that lets the funnel scale past one operator. An organizer deploys an event in one call; a participant completes the whole protocol path (join, encrypt, submit) with no human in the loop. The remaining conversion lever — the public-facing UI — is the frontend half, now unblocked for Elliot.

**What went well.**
- The single worst conversion-killer from Barcelona — the manual group-inclusion relay — is **structurally gone**, replaced by on-chain self-join, delivering Work Order #0's recommendation and Work Order #1 §6.2 in full (and one better: self-join, not organizer-admits).
- The entire loop re-shipped cleanly across five layers (contract, MCP, two SDKs, skill, tool) and was mainnet-verified, with a zero-loss state migration that preserved the existing Barcelona group.
- The self-join gate is contract-enforced, so the automation that serves open hackathons cannot leak into the confidential B2B/B2Gov groups that are NOVA's core thesis.
- `create_hackathon_group` folds a three-step, error-prone setup into one call, and the build caught a real latent bug (a keyless group) before any city node could hit it.

**Challenges encountered.**
- **The keyless-group bug** — a group could be created joinable but without its Shade encryption key, authorizing joiners who then had nothing to encrypt with. Caught during the build and folded into the one-call primitive so it cannot recur, but a reminder that "register the group" and "provision its key" must be atomic from the organizer's point of view.
- **Coordinating a five-layer ship** (contract → MCP → SDK → skill → tool) means each layer's change is only as done as the layer below it is deployed and verified; the sequence had to be strict (contract first, tool last) so no layer shipped against a backend that couldn't yet serve it.
- **The scope splits across two contributors.** Work Order #1's deliverables span a backend half (mine) and a frontend half (Elliot's / NEARBuilders); keeping the handoff boundary clean — and reporting honestly against it — matters more than claiming the whole scope.

**What I learned / recommendations.**
- **Automate the human step, don't instruct around it.** Barcelona's loss wasn't a documentation gap a better tutorial would fix — it was a manual round-trip only removal could solve. When a funnel drops off at a manual step, automate the step; a clearer explanation of a manual step is still a manual step.
- **Gate the automation structurally, not by convention.** Self-join had to be contract-*impossible* for private groups, not disallowed in a README, because NOVA's whole thesis is that confidential groups stay confidential even with a convenient path beside them.
- **The next lever is the frontend, and it is not mine.** The backend is complete; the remaining conversion gain (a public event page any organizer can point participants at) is Elliot's frontend, now unblocked. The most useful thing I can do for the funnel now is keep that handoff clean.

---

## Compensation

**Requested: 500 NEAR** against the Work Order #1 maximum of 1,000 NEAR.

The request reflects the **delivered backend half** of the Work Order #1 scope — self-service member-management (Deliverable 2), automated deadline judging (3), the typed-API surface + enabling hardening (6), and organizer/participant documentation (7), plus the backend of the deployment engine (1). The **frontend half** — the deployment-engine UI, public event/project pages (4), and the Launchpad intake bridge (5) — is Elliot's / NEARBuilders build, not delivered this period, and is deliberately excluded from the request. The backend it consumes is live and mainnet-verified.

---

## Links (consolidated)

**IronClaw Hackathon engine**
- Skill repo: https://github.com/jcarbonnell/ironclaw-hackathon
- Updated skill (self-join submit, v0.4.0): https://github.com/jcarbonnell/ironclaw-hackathon/tree/main/skill
- Organizer / judge side: https://github.com/jcarbonnell/ironclaw-hackathon/tree/main/judge
- `nova-submit` tool release (v0.2.0): https://github.com/jcarbonnell/nova/releases/tag/nova-submit-v0.2.0

**Ecosystem integration**
- ironhub issue: https://github.com/nearai/ironhub/issues/249
- ironhub repo: https://github.com/nearai/ironhub

**Codebase & on-chain**
- Codebase: https://github.com/jcarbonnell/nova
- On-chain activity: https://nearblocks.io/address/nova-sdk.near

---

*Submitted by Julien Carbonnell (CivicTech OU) · NEAR wallet nova-sdk.near · under the MultiAgency Services Agreement dated July 3, 2026, and Work Order #1 (Effective Date July 15, 2026; MultiAgency Representative James Waugh).*

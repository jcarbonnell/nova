# Julien Carbonnell (CivicTech OU) — IronClaw Hackathon Engine, Growth Infrastructure & Submission-Layer Security Patch

**Reporting period:** June 15 – July 15, 2026
**Contributor:** Julien Carbonnell (CivicTech OU)
**NEAR wallet:** nova-sdk.near
**Attached to:** MultiAgency Work Order #0
**IP model:** Open-source contribution (MIT)

---

## Summary

Three bodies of work delivered this period, all in production on NEAR mainnet:

1. **Built and ran the IronClaw Hackathon engine in production** — the submission and judging pipeline for NEAR Legion city-node hackathons — validated end-to-end at the Barcelona event (June 18, 2026), with the `nova-submit` tool now shipping by default in IronClaw and a reproducible three-video onboarding workshop series.
2. **Architected that engine into an Autonomous Growth Infrastructure for the NEAR ecosystem** — the event-abstraction design that wires the hackathon submission layer, the IronClaw skill/tool catalog, and the NEAR Innovation Launchpad into a single repeatable funnel (onboarding → submission/judging → distribution).
3. **Shipped a production security patch to the submission substrate** — closing the eight findings of an independent code audit before the platform takes on the roadmap's next set of features, verified live on mainnet.

Each is detailed below with links and outcomes.

---

## 1 · IronClaw Hackathon engine — built, shipped, run in production

**What it is.** A repeatable submission-and-judging pipeline for hackathons: participants' IronClaw agents encrypt and submit their entries to an on-chain group that only the organizer can decrypt; a single organizer script collects, decrypts, and integrity-checks every submission at the deadline. Three layers, wired together by an event abstraction:

- **`ironclaw-hackathon` skill** — a single `SKILL.md` (prompt extension) that teaches an IronClaw agent how to register for an event and submit an entry. Event-specific group ID abstracted as a parameter, so the same skill works across every event.
  - Repo: https://github.com/jcarbonnell/ironclaw-hackathon
  - Skill: https://github.com/jcarbonnell/ironclaw-hackathon/blob/main/skill/SKILL.md
- **`nova-submit` tool** — a compiled WebAssembly component (sandboxed, ~190 KB) that performs the deterministic work the agent shouldn't improvise: client-side AES-256-GCM encryption, upload, and on-chain recording. **Now shipped by default in IronClaw releases.**
  - Release: https://github.com/jcarbonnell/nova/releases/tag/nova-submit-v0.1.0
- **`judge.mjs` organizer script** — reads the event group's on-chain transaction log, retrieves and decrypts every submission, integrity-checks each. The whole collection-and-judging pipeline in one command.
  - Docs: https://github.com/jcarbonnell/ironclaw-hackathon/blob/main/judge/README.md

**Production validation — Barcelona, June 18, 2026.** The engine ran end-to-end on NEAR mainnet at the NEAR Legion Barcelona city-node hackathon. All operations — organizer-side and participant-side — are visible on-chain:

- On-chain activity: https://nearblocks.io/address/nova-sdk.near
- Event page (Luma): https://luma.com/h2az9d83

Outcome, honestly reported: **~75 participants registered**; an estimated **~70 were active remotely** during the hackathon window (inferred from ~150 YouTube views on the kickoff + first workshop within the first 24h, consistent with the registration count); **1 formal submission** completed through the pipeline, with ~7 more participants reporting in-person that they had started the tutorial but did not finish in time. The infrastructure itself performed without bugs — every organizer and participant call went through cleanly on mainnet (verifiable at the address above). The gap was in submission completion, not in the engine (see Assessment).

**Reproducible onboarding — three-video workshop series.** To make the engine self-serve for any future event, I produced and published a three-part video workshop that walks a participant from zero to a submitted entry:

- Kickoff — hackathon details and overview: https://www.youtube.com/watch?v=z_FG6YnhXEI
- Workshop 1 — Deploy your first IronClaw agent: https://www.youtube.com/watch?v=4xofKRnZvoc
- Workshop 2 — Add a skill + tool, register, and submit (incl. the organizer judging view): https://www.youtube.com/watch?v=Tc4quhPjCyM

The workshop scripts double as durable documentation and are written to be event-agnostic (the tutorial at `ironclaw.nearbuilders.org/setup` needs no per-event copies).

---

## 2 · Architecting the Autonomous Growth Infrastructure

Beyond running one event, I designed how the engine becomes a **repeatable growth funnel for the NEAR ecosystem**, mapping to the Q3 strategy's *Onboarding · Submission/Judging · Distribution* framing:

- **Onboarding** — one-click event deployment surfaced through `ironclaw.nearbuilders.org`: an organizer fills a short form (location, date, deadline, prize tracks, organizer account + API key) and the engine creates the event's submission group and a public landing page. No organizer rebuilds submission infrastructure per event.
- **Submission & judging** — the engine above, cloneable per event via the abstracted group-ID parameter.
- **Distribution** — a bridge from finished hackathon project to ecosystem traction: each project page carries a "request Launchpad campaign" action that routes a project (with its GitHub repo URL) into the NEAR Innovation Launchpad intake. The repo-URL requirement acts as a natural quality filter. This makes every hackathon a structural feeder into post-event BD continuity — the answer to "what happens to good hackathon projects three weeks later."

This architecture is documented in two companion notes prepared this period: the **Autonomous Growth Infrastructure operational memo** and the **IronClaw Hackathon engine plan** (design of the `plugins/hackathons` surface, the NOVA-decrypted-at-deadline → DB → public-rendering storefront contract, and the Launchpad intake bridge). These frame the forward build (see Work Orders #1 and #2) and align with Elliot's in-preparation Strategy Document on the recurring hackathon flow.

---

## 3 · Submission-layer security patch (v0.3.2) — shipped to production

Before the platform takes on the deployment-engine and Launchpad-integration features, I closed the findings of an **independent code audit** (NEARBuilders) of the submission substrate:

- Audit: https://github.com/NEARBuilders/nova/blob/q3/docs/initial-research.md

**Eight fixes, all deployed and verified on mainnet:**

1. Rotated a leaked FastNEAR credential (deleted server-side — neutralizes every leaked copy) and removed a dead config artifact.
2. Deleted a debug endpoint that returned a live auth token to any authenticated session.
3. Added an internal-auth gate (shared-secret, timing-safe, fail-closed) on all key-management and user-key routes, so the TEE agent's public endpoint only serves its two legitimate internal callers; health endpoints exempted.
4. Hardened and audited the account-only signing path (kept for legitimate agent-signing, now gated + logged) rather than leaving it open.
5. Disabled an unauthenticated wallet key-retrieval path (returned 501, pending a genuine self-custody rebuild) — closing a path where knowing a public account ID could retrieve that account's key. Result: no unauthenticated key-retrieval path remains anywhere.
6. Fixed a token-verification flaw that let a caller impersonate any account by supplying their own public key; verification now always checks the signature against the account's on-chain keys. Proven with a standalone test (attacker self-key rejected; legitimate single- and multi-key access preserved).
7. Made master-seed initialization idempotent — a redeploy can no longer overwrite the root key and render every derived key unrecoverable.
8. Migrated key-blob encryption from AES-256-CBC to authenticated AES-256-GCM, with a backwards-compatible read path. Verified in production: the existing pre-patch blobs (including the master seed) read correctly under the new code. Proven with a standalone test (round-trip + tamper-rejection) before deploy.

**Verification evidence (production):** the internal-auth gate returns 403 to header-less requests and 200 to health checks; the master seed loaded from on-chain KV under the new GCM-capable reader (backwards-compat proven on real data); email login works end-to-end through the live gate. Fixes 6 and 8 each additionally proven by standalone test harnesses. Two dependency-drift incidents surfaced during deploy (an unpinned FastMCP and PyJWT each resolved to a newer, behavior-changing version on rebuild) and were resolved by pinning the dependency set to the known-good versions — recorded as a follow-up hardening item.

Fixes #7 (master-seed one-shot) and #8 (GCM) also directly satisfy items in the NEARBuilders rebuild tickets, so this patch is both a security close-out and a down-payment on the agreed convergence with the NEARBuilders team.

---

## Assessment — how this supports the project, client, and ecosystem

**Ecosystem objective.** NEAR Foundation's goal for IronClaw is a growing catalog of open-source skills and tools built by the dev community, with the NEAR Legion city-node hackathon series as the contribution funnel. This period delivered the *mechanism* that makes that funnel repeatable: a submission/judging engine any organizer can deploy, an onboarding workshop any participant can follow, and a distribution bridge that carries finished projects into the Launchpad. All three run in production today.

**What went well.**
- The engine performed flawlessly on mainnet at Barcelona — every organizer and participant call went through with no bugs, verifiable on-chain. The core infrastructure is proven.
- Strong remote support from the NEAR Legion team; solid registration numbers (~75) and workshop viewership (~150 views in 24h) relative to event size.
- `nova-submit` shipping by default in IronClaw means the tool is now permanently in front of every IronClaw user, not just this event's participants.
- The security audit was closed and deployed cleanly to a single production environment with no data loss, using local-first validation and standalone test harnesses to de-risk a staging-less deploy.

**Challenges encountered.**
- **Submission completion was the weak point** — 1 formal submission against ~70 active participants. The infrastructure worked; the human funnel didn't convert. Diagnosis: a coding-school student audience proved less agile and self-directed than established professionals — shy about their skills, and their dynamics constrained by the school's corporate structure. The one remaining manual step (relaying the NOVA account ID to staff for group inclusion) added friction. Cash incentives likely wouldn't have moved this particular cohort.
- **Dependency drift on rebuild** during the security deploy (unpinned FastMCP/PyJWT) caused two avoidable incidents, since resolved and turned into a pinning discipline going forward.

**What I learned / recommendations.**
- The audience lesson compounds across events: the previous event taught me to target developers over a mainstream crypto crowd (hence the coding-school partnership); this one taught me that *established professionals* convert better than students. Future city-node events should bias toward experienced developer communities.
- The manual group-inclusion step should be automated into the deployment engine — this is a concrete Work Order #1 item (automated member management as part of the one-click deploy).
- Pin all build dependencies; treat any `--no-cache` rebuild as a potential behavior change.
- A note on event budget that I'd carry forward: the ~$450 spent on food and drinks for participants (~50 meals served) was, in my honest assessment, the single best use of event money — there is real precariousness in the student and tech-freelancer communities, and it built genuine goodwill toward the ecosystem.

---

## Links (consolidated)

**IronClaw Hackathon engine**
- Skill repo: https://github.com/jcarbonnell/ironclaw-hackathon
- Skill file: https://github.com/jcarbonnell/ironclaw-hackathon/blob/main/skill/SKILL.md
- Judge docs: https://github.com/jcarbonnell/ironclaw-hackathon/blob/main/judge/README.md
- `nova-submit` tool release: https://github.com/jcarbonnell/nova/releases/tag/nova-submit-v0.1.0

**Barcelona event (June 18, 2026)**
- Event (Luma): https://luma.com/h2az9d83
- On-chain activity: https://nearblocks.io/address/nova-sdk.near
- Kickoff video: https://www.youtube.com/watch?v=z_FG6YnhXEI
- Workshop 1 (deploy agent): https://www.youtube.com/watch?v=4xofKRnZvoc
- Workshop 2 (skill + submit + judge): https://www.youtube.com/watch?v=Tc4quhPjCyM
- Event asset drive: https://drive.google.com/drive/folders/1hAnHPxAjH_2QtNmxFc3H8DbVpgUf2Oe2

**Security patch (v0.3.2)**
- Audit addressed: https://github.com/NEARBuilders/nova/blob/q3/docs/initial-research.md
- Codebase: https://github.com/jcarbonnell/nova

---

*Submitted by Julien Carbonnell (CivicTech OU) · NEAR wallet nova-sdk.near · under the MultiAgency Services Agreement dated July 3, 2026.*
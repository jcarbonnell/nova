// nova/shade-agent/src/index.ts
//
// 7.5 — NON-BLOCKING STARTUP.
//
// PREVIOUSLY: four RPC-dependent operations ran BEFORE serve() — ShadeClient.create()
// (top-level await), agent.balance(), the conditional agent.fund(), and the
// `while(true)` registration loop. Until all four completed, nothing listened on
// :3000. A slow start was externally INDISTINGUISHABLE FROM A CRASH: no /health,
// no port, nothing for Phala or a healthcheck to observe. On a throttled RPC
// endpoint that window can be minutes.
//
// NOW: the HTTP server binds first, within milliseconds. Agent bootstrap runs as a
// background task that updates module-level state as it progresses. `/` reports
// `degraded` while that is in flight and `healthy` once the agent is registered.
//
// STATUS IS ALWAYS HTTP 200 — never 503. Deliberate (7.5 decision):
//   - The healthcheck's job (7.6) is to catch a HUNG-BUT-NOT-CRASHED process. A
//     hung process returns nothing; a starting process returns 200 + degraded.
//     That distinction is exactly what we want to observe.
//   - Single CVM, no load balancer: there is no traffic to gate on readiness.
//   - 503 would make the healthcheck fail → Phala restarts → boot re-runs. If the
//     boot is slow BECAUSE RPC is throttled, restarting makes it strictly worse.
//     A crash-loop driven by the very condition we are trying to survive.

import dotenv from "dotenv";
dotenv.config();

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { ShadeClient } from "@neardefi/shade-agent-js";
import { JsonRpcProvider } from "@near-js/providers";

import { mountRpc } from "./rpc/mount.js";
import { startScheduler } from "./lib/services/scheduler-live.js";
import { log } from "./lib/logger.js";

import { NOVA_MAINNET_CONTRACT, NOVA_TESTNET_CONTRACT, getRpcUrl } from "./lib/config.js";
import { validateBootEnv } from "./lib/boot-config.js";
import { initializeMasterSeed } from "./lib/seed.js";
import { hasMasterSeed } from "./lib/crypto.js";
import { signerPublicKeyFor } from "./lib/kv.js";
import { FASTFS_RECEIVER } from "./lib/fastfs.js";
import { createRegistrar } from "./lib/registration.js";
import { initializeLegacy, getLegacyStatus } from "./lib/legacy.js";

// ────────────────────────────────────────────────
// Environment validation (§5.12: lib/boot-config.ts)
// ────────────────────────────────────────────────
//
// Throws at module load, DELIBERATELY: a Shade Agent without its contracts cannot
// perform any of its functions. Also requires a well-formed TEE_KEY_SECRET,
// refuses MASTER_SEED_INIT_ALLOWED in production, and refuses a sponsor that is
// not a dedicated funding account.

const boot = validateBootEnv(process.env);
const { agentContractId, kvContractId, network, isProduction, sponsor } = boot;

console.log("🔧 Initializing NOVA Shade Agent 2.0...");
console.log(`📍 Environment: ${isProduction ? "production (Phala CVM)" : "development (local)"}`);
console.log(`🔐 KV Contract: ${kvContractId}`);
console.log(`🌐 Sponsor Account: ${sponsor ? sponsor.accountId : "none (agent funding disabled)"}`);
console.log(`📜 Agent Contract: ${agentContractId}`);

// ────────────────────────────────────────────────
// Master seed + signer keys (§5.12) — in the background, after serve()
// ────────────────────────────────────────────────
//
// The seed is read from KV (`master-root`, decrypted with TEE_KEY_SECRET), which
// is an RPC call, so it follows 7.5's bind-first rule. A failure is logged, not
// fatal: every route loads the seed again through the rpc/base.ts middleware.
//
// The signer public keys are logged as a CHECK: the operator computes them from
// the seed before the first boot and adds each one to nova-sdk.near as a
// function-call key restricted to its receiver. They are public keys.

async function loadSeedAndLogSigners(): Promise<void> {
  try {
    await initializeMasterSeed();
    console.log("🔑 Signer keys (function-call keys on nova-sdk.near, one per receiver):");
    for (const receiver of [kvContractId, FASTFS_RECEIVER, NOVA_MAINNET_CONTRACT]) {
      console.log(`   ${receiver}: ${await signerPublicKeyFor(receiver)}`);
    }
    // §5.12 L4: needs the seed (its KV signer writes the key copy). Never throws.
    await initializeLegacy();
  } catch (error) {
    log("error", "master_seed_load_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// ────────────────────────────────────────────────
// Agent lifecycle state
// ────────────────────────────────────────────────
//
// Mutable module state, read by the route handlers at REQUEST time (closures, so
// they see whatever the background task has set by then). This is what lets the
// routes exist before the agent does.

type AgentPhase =
  | "starting"      // process up, client not yet created
  | "registering"   // client created, waiting on registration (lib/registration.ts)
  | "registered"    // registered at least once; validity is in valid_until_ms (D2)
  | "error";        // client creation failed outright

let clientPhase: "starting" | "created" | "error" = "starting";
let agentInstance: ShadeClient | null = null;
let agentAccountId: string | null = null;
let clientError: string | null = null;
let registrar: ReturnType<typeof createRegistrar> | null = null;

function agentPhaseNow(): AgentPhase {
  if (clientPhase !== "created") return clientPhase === "error" ? "error" : "starting";
  return registrar?.state.phase ?? "registering";
}
function lastAgentError(): string | null {
  return clientError ?? registrar?.state.lastError ?? null;
}

/**
 * Accessor for the agent, for any module that needs it.
 *
 * ⚠️ REPLACES the previous `export const agent = await ShadeClient.create(...)`.
 * That export cannot survive non-blocking startup: the value does not exist at
 * module-evaluation time any more. Any importer must call this and handle null.
 * See the deploy note — confirm nothing still does `import { agent }`.
 */
export function getAgent(): ShadeClient | null {
  return agentInstance;
}

export function getAgentPhase(): AgentPhase {
  return agentPhaseNow();
}

// ────────────────────────────────────────────────
// Agent funding and registration (§5.12 D1–D4): lib/registration.ts
// ────────────────────────────────────────────────
//
// Inside the TEE every boot is a NEW random agent account whose key never leaves
// the CVM, so whatever is sent to it is lost at the next reboot. The registrar
// tops it up before each attempt (D3/D4), retries with backoff (D3), and
// re-registers a day before the contract's own expiry, retrying until it
// succeeds (D1). `/` reports that expiry (D2).

// ────────────────────────────────────────────────
// Background bootstrap (was: everything above serve())
// ────────────────────────────────────────────────

async function bootstrapAgent(): Promise<void> {
  // 1. Create the client (RPC-dependent).
  try {
    agentInstance = await ShadeClient.create({
      networkId: network,
      agentContractId,
      // Our own (keyed) RPC. Without it shade-agent-js uses FastNear's anonymous
      // free tier: the 429s of 27 October.
      rpc: new JsonRpcProvider({ url: getRpcUrl(network) }),
      // §5.12: NO derivationPath. It used to be the sponsor's private key, so the
      // agent key was derivable by anyone holding it. Inside the TEE, 2.2.0 draws a
      // random agent key per boot that never leaves the CVM.
      ...(sponsor ? { sponsor } : {}),
    });

    agentAccountId = agentInstance.accountId();
    console.log(`🤖 Agent Account ID: ${agentAccountId}`);

    // Consumed by other modules (attestation, key-management). Set as early as
    // possible after the account is known.
    process.env.SHADE_AGENT_ACCOUNT_ID = agentAccountId;

    clientPhase = "created";
  } catch (error) {
    clientPhase = "error";
    clientError = error instanceof Error ? error.message : String(error);
    // Scrubbed: SDK errors echo the RPC URL, which carries ?apiKey= (7.1).
    log("error", "agent_client_creation_failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return; // nothing further is possible without a client
  }

  // 2–4. Top up, register (retry with backoff), re-register before expiry —
  //      forever, in the background. Phase stays `registering` (=> `degraded`)
  //      until the first success, observable on `/`.
  console.log("🔐 Registering agent with contract...");
  registrar = createRegistrar({
    agent: agentInstance,
    hasSponsor: !!sponsor,
    log: (level, event, data) => log(level, event, data ?? {}),
  });
  await registrar.run();
}

// ────────────────────────────────────────────────
// HTTP app
// ────────────────────────────────────────────────

const app = new Hono();

app.use(cors());
mountRpc(app);

/**
 * Root health check — UNGATED, and the target for the 7.6 compose healthcheck.
 *
 * ALWAYS 200. `status` is "healthy" only once the agent is registered AND the
 * master seed is loaded; "degraded" otherwise. A healthcheck that only asserts a response
 * therefore passes during startup (correct: the process is alive and serving)
 * while an operator or a monitor can still read `agent_phase` to see readiness.
 */
app.get("/", (c) => {
  const validUntilMs = registrar?.state.validUntilMs ?? null;
  return c.json({
    // D2: healthy only while the contract's own validity is in the future.
    status: registrar?.isValid() && hasMasterSeed() ? "healthy" : "degraded",
    service: "nova-shade-agent-2.0",
    version: "2.0.0",
    agent_phase: agentPhaseNow(),
    master_seed: hasMasterSeed() ? "loaded" : "not loaded",
    legacy: getLegacyStatus(), // §5.12 L4: key_copy_stored ⇒ LEGACY_TEE_KEY_SECRET can be removed
    agent_account: agentAccountId,
    registered_at: registrar?.state.registeredAt ?? null,
    valid_until_ms: validUntilMs,
    valid_until: validUntilMs === null ? null : new Date(validUntilMs).toISOString(),
    last_error: lastAgentError(),
    environment: isProduction ? "production" : "development",
    timestamp: new Date().toISOString(),
  });
});

// Agent info route
app.get("/api/agent-info", async (c) => {
  // The agent may not exist yet — this route used to be reachable only after a
  // successful bootstrap, which is no longer guaranteed at request time.
  if (!agentInstance) {
    return c.json(
      {
        error: "Agent not ready",
        agent_phase: agentPhaseNow(),
        last_error: lastAgentError(),
      },
      503
    );
  }

  try {
    const accountId = agentInstance.accountId();
    const balance = await agentInstance.balance();
    const isWhitelisted = await agentInstance.isWhitelisted();

    return c.json({
      accountId,
      balance,
      agentContractId,
      network,
      isWhitelisted,
      agentPhase: agentPhaseNow(),
      kvContract: kvContractId,
      novaMainnet: NOVA_MAINNET_CONTRACT,
      novaTestnet: NOVA_TESTNET_CONTRACT,
      environment: isProduction ? "production" : "development",
    });
  } catch (error) {
    log("error", "agent_info_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to get agent info", code: "AGENT_INFO_FAILED" }, 500);
  }
});

// Global error handler
app.onError((err, c) => {
  log("error", "unhandled_error", {
    path: c.req.path,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: "Internal server error" }, 500);
});

// ────────────────────────────────────────────────
// Bind FIRST, then bootstrap
// ────────────────────────────────────────────────

const port = Number(process.env.PORT || "3000");

serve({ fetch: app.fetch, port });

console.log(`\n🚀 NOVA Shade Agent 2.0 listening on http://localhost:${port}`);
console.log(`   Status: degraded (agent bootstrap starting in background)`);
console.log(`\n📋 Available routes:`);
console.log(`   - GET  /                              (health check)`);
console.log(`   - POST /rpc/user-keys/store`);
console.log(`   - POST /rpc/user-keys/retrieve`);
console.log(`   - POST /rpc/user-keys/check`);
console.log(`   - POST /rpc/user-keys/generate-api-key`);
console.log(`   - POST /rpc/user-keys/has-api-key`);
console.log(`   - POST /rpc/user-keys/verify-api-key`);
console.log(`   - POST /rpc/key-management/generate_key`);
console.log(`   - POST /rpc/key-management/get_key`);
console.log(`   - POST /rpc/key-management/rotate_key`);

// §6.1 Piece 4 — scheduler (window sweep + daily retention). Starts right after
// serve(), INDEPENDENT of agent registration: neither job uses the agent account
// (owner keys / the nova-sdk.near KV signer), and a stalled whitelist must not
// leave buyers with access. No-op unless SCHEDULER_ENABLED === 'true'.
startScheduler();

// Master seed in the background (fire and forget; failures are logged inside).
void loadSeedAndLogSigners();

// Fire and forget. Never awaited — that is the entire point of 7.5.
// A throw inside is already handled (phase => "error"); this catch is a
// last-resort guard so an unexpected rejection cannot become an unhandled one.
void bootstrapAgent().catch((error) => {
  clientPhase = "error";
  clientError = error instanceof Error ? error.message : String(error);
  log("error", "agent_bootstrap_failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});
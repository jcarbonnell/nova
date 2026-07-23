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

import { mountRpc } from "./rpc/mount.js";
import { log } from "./lib/logger.js";

import { NOVA_MAINNET_CONTRACT, NOVA_TESTNET_CONTRACT } from "./lib/config.js";

// ────────────────────────────────────────────────
// Environment validation
// ────────────────────────────────────────────────
//
// These throws stay at module load, DELIBERATELY — unlike the frontend items in
// roadmap step 10. A Shade Agent without TEE_KEY_SECRET or KV_CONTRACT_ID cannot
// perform any of its functions; every request would error. Failing fast at boot
// is correct here. (The frontend case differs: there a missing var turns a
// runtime 500 into a BUILD failure.) Not an oversight — a considered difference.

const agentContractId = process.env.AGENT_CONTRACT_ID;
const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
const sponsorPrivateKey = process.env.SPONSOR_PRIVATE_KEY;
const teeKeySecret = process.env.TEE_KEY_SECRET;
const kvContractId = process.env.KV_CONTRACT_ID;
const auth0Domain = process.env.AUTH0_DOMAIN;

if (!agentContractId || !sponsorAccountId || !sponsorPrivateKey) {
  throw new Error(
    "Missing required environment variables: AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY"
  );
}

if (!teeKeySecret || !kvContractId || !auth0Domain) {
  throw new Error(
    "Missing NOVA environment variables: TEE_KEY_SECRET, KV_CONTRACT_ID, AUTH0_DOMAIN"
  );
}

const isProduction = process.env.NODE_ENV === "production";
const network = agentContractId.endsWith(".testnet") ? "testnet" : "mainnet";

console.log("🔧 Initializing NOVA Shade Agent 2.0...");
console.log(`📍 Environment: ${isProduction ? "production (Phala CVM)" : "development (local)"}`);
console.log(`🔐 KV Contract: ${kvContractId}`);
console.log(`🌐 Sponsor Account: ${sponsorAccountId}`);
console.log(`📜 Agent Contract: ${agentContractId}`);

// ────────────────────────────────────────────────
// Agent lifecycle state
// ────────────────────────────────────────────────
//
// Mutable module state, read by the route handlers at REQUEST time (closures, so
// they see whatever the background task has set by then). This is what lets the
// routes exist before the agent does.

type AgentPhase =
  | "starting"      // process up, client not yet created
  | "registering"   // client created, waiting on whitelist/registration
  | "registered"    // fully operational
  | "error";        // client creation failed outright

let agentPhase: AgentPhase = "starting";
let agentInstance: ShadeClient | null = null;
let agentAccountId: string | null = null;
let lastAgentError: string | null = null;
let registeredAt: string | null = null;

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
  return agentPhase;
}

// ────────────────────────────────────────────────
// Background bootstrap (was: everything above serve())
// ────────────────────────────────────────────────

async function bootstrapAgent(): Promise<void> {
  // 1. Create the client (RPC-dependent).
  try {
    agentInstance = await ShadeClient.create({
      networkId: network,
      agentContractId: agentContractId!,
      sponsor: {
        accountId: sponsorAccountId!,
        privateKey: sponsorPrivateKey!,
      },
      derivationPath: sponsorPrivateKey!,
    });

    agentAccountId = agentInstance.accountId();
    console.log(`🤖 Agent Account ID: ${agentAccountId}`);

    // Consumed by other modules (attestation, key-management). Set as early as
    // possible after the account is known.
    process.env.SHADE_AGENT_ACCOUNT_ID = agentAccountId;

    agentPhase = "registering";
  } catch (error) {
    agentPhase = "error";
    lastAgentError = error instanceof Error ? error.message : String(error);
    // Scrubbed: SDK errors echo the RPC URL, which carries ?apiKey= (7.1).
    log("error", "agent_client_creation_failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return; // nothing further is possible without a client
  }

  // 2. Fund if low (RPC-dependent, non-fatal).
  try {
    const balance = await agentInstance.balance();
    console.log(`💰 Agent Balance: ${balance.toFixed(4)} NEAR`);
    // Threshold must exceed the cost of registration: ~0.30 NEAR.
    if (balance < 0.5) {
      console.log("💸 Funding agent with 1 NEAR...");
      await agentInstance.fund(1);
      console.log("✅ Agent funded");
    }
  } catch (error) {
    // Do not abort: registration may still succeed on an existing balance.
    log("warn", "agent_funding_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // 3. Register — the old `while(true)`, now in the background.
  //    Retries forever by design: the operator may still need to whitelist the
  //    agent. Phase stays `registering` (=> /health `degraded`) throughout, which
  //    is now OBSERVABLE rather than a silent hang with no listening port.
  console.log("🔐 Registering agent with contract...");
  while (true) {
    try {
      const isWhitelisted = await agentInstance.isWhitelisted();
      if (isWhitelisted === null || isWhitelisted) {
        const registered = await agentInstance.register();
        if (registered) {
          agentPhase = "registered";
          registeredAt = new Date().toISOString();
          lastAgentError = null;
          console.log("✅ Agent registered successfully");
          break;
        }
      }
    } catch (error) {
      lastAgentError = error instanceof Error ? error.message : String(error);
      log("error", "agent_registration_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    console.log("⏳ Waiting for whitelist... (run 'shade whitelist' in another terminal)");
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  // 4. Re-register every 6 days. Unchanged — already non-blocking.
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const registered = await agentInstance!.register();
      if (registered) {
        console.log("🔄 Agent re-registered");
      }
    } catch (error) {
      log("error", "agent_reregistration_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, SIX_DAYS_MS);
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
 * ALWAYS 200. `status` is "healthy" only once the agent is registered;
 * "degraded" at every other phase. A healthcheck that only asserts a response
 * therefore passes during startup (correct: the process is alive and serving)
 * while an operator or a monitor can still read `agent_phase` to see readiness.
 */
app.get("/", (c) =>
  c.json({
    status: agentPhase === "registered" ? "healthy" : "degraded",
    service: "nova-shade-agent-2.0",
    version: "2.0.0",
    agent_phase: agentPhase,
    agent_account: agentAccountId,
    registered_at: registeredAt,
    last_error: lastAgentError,
    environment: isProduction ? "production" : "development",
    timestamp: new Date().toISOString(),
  })
);

// Agent info route
app.get("/api/agent-info", async (c) => {
  // The agent may not exist yet — this route used to be reachable only after a
  // successful bootstrap, which is no longer guaranteed at request time.
  if (!agentInstance) {
    return c.json(
      {
        error: "Agent not ready",
        agent_phase: agentPhase,
        last_error: lastAgentError,
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
      agentPhase,
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

// Fire and forget. Never awaited — that is the entire point of 7.5.
// A throw inside is already handled (phase => "error"); this catch is a
// last-resort guard so an unexpected rejection cannot become an unhandled one.
void bootstrapAgent().catch((error) => {
  agentPhase = "error";
  lastAgentError = error instanceof Error ? error.message : String(error);
  log("error", "agent_bootstrap_failed", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { ShadeClient } from "@neardefi/shade-agent-js";
// Import NOVA routes
import userKeys from "./routes/user-keys";
import keyManagement from "./routes/key-management";
// Load environment variables
if (process.env.NODE_ENV !== "production") {
    dotenv.config();
}
// Validate required environment variables
const agentContractId = process.env.AGENT_CONTRACT_ID;
const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
const sponsorPrivateKey = process.env.SPONSOR_PRIVATE_KEY;
const teeKeySecret = process.env.TEE_KEY_SECRET;
const kvContractId = process.env.KV_CONTRACT_ID;
const auth0Domain = process.env.AUTH0_DOMAIN;
if (!agentContractId || !sponsorAccountId || !sponsorPrivateKey) {
    throw new Error("Missing required environment variables: AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY");
}
if (!teeKeySecret || !kvContractId || !auth0Domain) {
    throw new Error("Missing NOVA environment variables: TEE_KEY_SECRET, KV_CONTRACT_ID, AUTH0_DOMAIN");
}
console.log("🔧 Initializing NOVA Shade Agent 2.0...");
console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`🔐 KV Contract: ${kvContractId}`);
console.log(`🌐 Sponsor Account: ${sponsorAccountId}`);
console.log(`📜 Agent Contract: ${agentContractId}`);
// Initialize Shade Agent client
// This handles TEE attestation and registration
export const agent = await ShadeClient.create({
    networkId: agentContractId.endsWith(".testnet") ? "testnet" : "mainnet",
    agentContractId: agentContractId,
    sponsor: {
        accountId: sponsorAccountId,
        privateKey: sponsorPrivateKey,
    },
    // Derivation path for deterministic agent account ID
    derivationPath: sponsorPrivateKey,
});
const agentAccountId = agent.accountId();
console.log(`🤖 Agent Account ID: ${agentAccountId}`);
// Set SHADE_AGENT_ACCOUNT_ID for routes to use
process.env.SHADE_AGENT_ACCOUNT_ID = agentAccountId;
// Fund agent if balance is low
const balance = await agent.balance();
console.log(`💰 Agent Balance: ${balance} NEAR`);
if (balance < 0.2) {
    console.log("💸 Funding agent with 0.3 NEAR...");
    await agent.fund(0.3);
    console.log("✅ Agent funded");
}
// Register agent with contract (handles TEE attestation)
console.log("🔐 Registering agent with contract...");
while (true) {
    try {
        const isWhitelisted = await agent.isWhitelisted();
        if (isWhitelisted === null || isWhitelisted) {
            const registered = await agent.register();
            if (registered) {
                console.log("✅ Agent registered successfully");
                break;
            }
        }
    }
    catch (error) {
        console.error("❌ Registration error:", error);
    }
    console.log("⏳ Waiting for whitelist... (run 'shade whitelist' in another terminal)");
    await new Promise((resolve) => setTimeout(resolve, 10000));
}
// Re-register every 6 days (attestation expires after 7 days)
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
setInterval(async () => {
    try {
        const registered = await agent.register();
        if (registered) {
            console.log("🔄 Agent re-registered");
        }
    }
    catch (error) {
        console.error("❌ Re-registration error:", error);
    }
}, SIX_DAYS_MS);
// Initialize Hono app
const app = new Hono();
// Middleware
app.use(cors());
// Root health check
app.get("/", (c) => c.json({
    status: "healthy",
    service: "nova-shade-agent-2.0",
    version: "2.0.0",
    agent_account: agentAccountId,
    timestamp: new Date().toISOString()
}));
// Agent info route (shows attestation status)
app.get("/api/agent-info", async (c) => {
    try {
        const accountId = agent.accountId();
        const balance = await agent.balance();
        const isWhitelisted = await agent.isWhitelisted();
        return c.json({
            accountId,
            balance,
            agentContractId: process.env.AGENT_CONTRACT_ID,
            network: agentContractId.endsWith(".testnet") ? "testnet" : "mainnet",
            isWhitelisted,
            kvContract: kvContractId,
            novaMainnet: process.env.NOVA_CONTRACT_ID || "nova-sdk.near",
            novaTestnet: process.env.NOVA_TESTNET_CONTRACT_ID || "nova-sdk-6.testnet",
        });
    }
    catch (error) {
        console.error("Failed to get agent info:", error);
        return c.json({ error: "Failed to get agent info: " + error }, 500);
    }
});
// Mount NOVA routes
app.route("/api/user-keys", userKeys);
app.route("/api/key-management", keyManagement);
// Global error handler
app.onError((err, c) => {
    console.error("❌ Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
});
// Start server
const port = Number(process.env.PORT || "3000");
console.log(`\n🚀 NOVA Shade Agent 2.0 started successfully!`);
console.log(`📡 Server running on http://localhost:${port}`);
console.log(`\n📋 Available routes:`);
console.log(`   - GET  /                              (health check)`);
console.log(`   - GET  /api/agent-info                (agent status & attestation)`);
console.log(`   - GET  /api/user-keys/                (user keys health)`);
console.log(`   - POST /api/user-keys/store           (store user key)`);
console.log(`   - POST /api/user-keys/retrieve        (retrieve user key)`);
console.log(`   - POST /api/user-keys/check           (check key exists)`);
console.log(`   - GET  /api/key-management/health     (group keys health)`);
console.log(`   - POST /api/key-management/generate_key  (generate group key)`);
console.log(`   - POST /api/key-management/get_key    (get group key)`);
console.log(`   - POST /api/key-management/revoke_member (revoke + rotate)`);
serve({ fetch: app.fetch, port });

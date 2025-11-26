"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const shade_agent_js_1 = require("@neardefi/shade-agent-js");
const app = new hono_1.Hono();
app.get("/", async (c) => {
    try {
        // Get the agents account Id
        const accountId = await (0, shade_agent_js_1.agentAccountId)();
        // Get the balance of the agent account
        const balance = await (0, shade_agent_js_1.agent)("getBalance");
        return c.json({
            accountId: accountId.accountId,
            balance: balance.balance,
        });
    }
    catch (error) {
        console.log("Error getting agent account:", error);
        return c.json({ error: "Failed to get agent account " + error }, 500);
    }
});
exports.default = app;
//# sourceMappingURL=agentAccount.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const node_server_1 = require("@hono/node-server");
const cors_1 = require("hono/cors");
const dotenv_1 = __importDefault(require("dotenv"));
// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
    dotenv_1.default.config({ path: ".env.development.local" });
}
// Import routes
const ethAccount_1 = __importDefault(require("./routes/ethAccount"));
const agentAccount_1 = __importDefault(require("./routes/agentAccount"));
const transaction_1 = __importDefault(require("./routes/transaction"));
const key_management_1 = __importDefault(require("./routes/key-management"));
const user_keys_1 = __importDefault(require("./routes/user-keys"));
const app = new hono_1.Hono();
// Configure CORS to restrict access to the server
app.use((0, cors_1.cors)());
// Health check
app.get("/", (c) => c.json({ message: "NOVA Shade Agent is running" }));
// Routes
app.route("/api/eth-account", ethAccount_1.default);
app.route("/api/agent-account", agentAccount_1.default);
app.route("/api/transaction", transaction_1.default);
app.route("/api/key-management", key_management_1.default);
app.route("/api/user-keys", user_keys_1.default);
// Start the server
const port = Number(process.env.PORT || "3000");
console.log(`NOVA Shade Agent is running on port ${port}`);
(0, node_server_1.serve)({ fetch: app.fetch, port });
//# sourceMappingURL=index.js.map
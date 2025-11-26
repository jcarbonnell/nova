"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const hono_1 = require("hono");
const shade_agent_js_1 = require("@neardefi/shade-agent-js");
const ethereum_1 = require("../utils/ethereum");
const fetch_eth_price_1 = require("../utils/fetch-eth-price");
const ethers_1 = require("ethers");
const chainsig_js_1 = require("chainsig.js");
const { toRSV, uint8ArrayToHex } = chainsig_js_1.utils.cryptography;
const app = new hono_1.Hono();
app.get("/", async (c) => {
    try {
        // Fetch the environment variable inside the route
        const contractId = process.env.NEXT_PUBLIC_contractId;
        if (!contractId) {
            return c.json({ error: "Contract ID not configured" }, 500);
        }
        // Get the ETH price
        const ethPrice = await (0, fetch_eth_price_1.getEthereumPriceUSD)();
        if (!ethPrice) {
            return c.json({ error: "Failed to fetch ETH price" }, 500);
        }
        // Get the transaction and payload to sign
        const { transaction, hashesToSign } = await getPricePayload(ethPrice, contractId);
        // Call the agent contract to get a signature for the payload
        const signRes = await (0, shade_agent_js_1.requestSignature)({
            path: "ethereum-1",
            payload: uint8ArrayToHex(hashesToSign[0]),
            keyType: "Ecdsa",
        });
        console.log("signRes", signRes);
        // Reconstruct the signed transaction
        const signedTransaction = ethereum_1.Evm.finalizeTransactionSigning({
            transaction,
            rsvSignatures: [toRSV(signRes)],
        });
        // Broadcast the signed transaction
        const txHash = await ethereum_1.Evm.broadcastTx(signedTransaction);
        // Send back both the txHash and the new price optimistically
        return c.json({
            txHash: txHash.hash,
            newPrice: (ethPrice / 100).toFixed(2),
        });
    }
    catch (error) {
        console.error("Failed to send the transaction:", error);
        return c.json({ error: "Failed to send the transaction" }, 500);
    }
});
async function getPricePayload(ethPrice, contractId) {
    // Derive the price pusher Ethereum address
    const { address: senderAddress } = await ethereum_1.Evm.deriveAddressAndPublicKey(contractId, "ethereum-1");
    // Create a new JSON-RPC provider for the Ethereum network
    const provider = new ethers_1.JsonRpcProvider(ethereum_1.ethRpcUrl);
    // Create a new contract interface for the Ethereum Oracle contract
    const contract = new ethers_1.Contract(ethereum_1.ethContractAddress, ethereum_1.ethContractAbi, provider);
    // Encode the function data for the updatePrice function
    const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
    // Prepare the transaction for signing 
    const { transaction, hashesToSign } = await ethereum_1.Evm.prepareTransactionForSigning({
        from: senderAddress,
        to: ethereum_1.ethContractAddress,
        data,
    });
    return { transaction, hashesToSign };
}
exports.default = app;
//# sourceMappingURL=transaction.js.map
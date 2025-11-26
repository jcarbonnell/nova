"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Evm = exports.ethContractAbi = exports.ethContractAddress = exports.ethRpcUrl = void 0;
const chainsig_js_1 = require("chainsig.js");
const viem_1 = require("viem");
exports.ethRpcUrl = "https://sepolia.drpc.org";
exports.ethContractAddress = "0xb8d9b079F1604e9016137511464A1Fe97F8e2Bd8";
exports.ethContractAbi = [
    {
        inputs: [
            {
                internalType: "uint256",
                name: "_price",
                type: "uint256",
            },
        ],
        name: "updatePrice",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
    },
    {
        inputs: [],
        name: "getPrice",
        outputs: [
            {
                internalType: "uint256",
                name: "",
                type: "uint256",
            },
        ],
        stateMutability: "view",
        type: "function",
    },
];
// Set up a chain signature contract instance
const MPC_CONTRACT = new chainsig_js_1.contracts.ChainSignatureContract({
    networkId: `testnet`,
    contractId: `v1.signer-prod.testnet`,
});
// Set up a public client for the Ethereum network
const publicClient = (0, viem_1.createPublicClient)({
    transport: (0, viem_1.http)(exports.ethRpcUrl),
});
// Set up a chain signatures chain adapter for the Ethereum network
exports.Evm = new chainsig_js_1.chainAdapters.evm.EVM({
    publicClient,
    contract: MPC_CONTRACT,
});
//# sourceMappingURL=ethereum.js.map
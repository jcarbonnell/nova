#!/usr/bin/env node
// @nova-sdk/plugin — local stdio MCP shim for Claude Code and Codex.
//
// B2: credential wiring + the first REAL tool (list_owned_groups). The server
// now constructs a NovaSdk from environment credentials and routes a tool call
// through it. Still one tool; more arrive in B3+.
//
// Design invariants (held from B1):
//  • Credential-agnostic: reads NOVA_* ONLY from process.env. Never hardcodes a
//    key; never assumes HOW the host populated the env (Claude userConfig→env,
//    Codex's own mechanism). One server binary serves both platforms.
//  • No secret logging: NOVA_API_KEY and any session token are NEVER written to
//    any stream. stdout is the MCP transport (JSON-RPC); non-secret human logs go
//    to stderr only. (The §10 FastNear/httpx leak class.)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import pkg from 'nova-sdk-js';
const { NovaSdk } = pkg;

// Read each value from BOTH conventions, in priority order:
//  1. CLAUDE_PLUGIN_OPTION_<KEY> — Claude Code exports these to HOOK processes
//     only (not MCP subprocesses), so for this stdio MCP server it's a defensive
//     fallback, not the primary path. Harmless, and covers any future hook use.
//  2. NOVA_<KEY> — the PRIMARY path for this MCP server: Claude Code substitutes
//     ${user_config.*} into .mcp.json's env → arrives here as NOVA_*. Also the
//     raw-env path used by Codex and by manual/CI runs. This is what keeps the
//     server credential-agnostic across hosts.
function envValue(key) {
  return process.env[`CLAUDE_PLUGIN_OPTION_${key}`] || process.env[key] || null;
}

const CONFIG = {
  apiKey: envValue('NOVA_API_KEY'),
  accountId: envValue('NOVA_ACCOUNT_ID'),
  mcpUrl: envValue('NOVA_MCP_URL'),
  authUrl: envValue('NOVA_AUTH_URL'),
  rpcUrl: envValue('NOVA_RPC_URL'),
  contractId: envValue('NOVA_CONTRACT_ID'),
};

// Non-secret boot line to stderr ONLY. Report presence of the key, never its value.
process.stderr.write(
  `[nova-plugin] starting (B2) — ` +
  `account=${CONFIG.accountId ?? '(unset)'} ` +
  `apiKey=${CONFIG.apiKey ? 'present' : '(unset)'} ` +
  `mcpUrl=${CONFIG.mcpUrl ?? '(default)'}\n`,
);

// ── NovaSdk factory ─────────────────────────────────────────────────────────────
// Built lazily so a missing credential surfaces as a clean tool-call error, not a
// boot crash (the server must still start and list tools even when unconfigured).
let sdkInstance = null;
function getSdk() {
  if (sdkInstance) return sdkInstance;
  if (!CONFIG.accountId) {
    throw new Error('NOVA_ACCOUNT_ID is not set. Configure the plugin with your NOVA account ID.');
  }
  if (!CONFIG.apiKey) {
    throw new Error('NOVA_API_KEY is not set. Configure the plugin with your NOVA API key from nova-sdk.com.');
  }
  const opts = { apiKey: CONFIG.apiKey };
  if (CONFIG.mcpUrl) opts.mcpUrl = CONFIG.mcpUrl;
  if (CONFIG.authUrl) opts.authUrl = CONFIG.authUrl;
  if (CONFIG.rpcUrl) opts.rpcUrl = CONFIG.rpcUrl;
  if (CONFIG.contractId) opts.contractId = CONFIG.contractId;
  sdkInstance = new NovaSdk(CONFIG.accountId, opts);
  return sdkInstance;
}

// Wrap a tool body: turn a thrown Error into an MCP error result, never leaking
// the API key. NovaError messages are safe (SDK does not embed the key in them).
async function runTool(fn) {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: result }] };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return { isError: true, content: [{ type: 'text', text: `NOVA error: ${msg}` }] };
  }
}

// ── MCP server ─────────────────────────────────────────────────────────────────
const server = new Server(
  { name: 'nova', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'list_owned_groups',
    description:
      'List the NOVA groups owned by the authenticated account. A group is a ' +
      'container for shared encrypted files with fine-grained membership. Takes ' +
      'no arguments; the account is derived from the configured credentials. ' +
      'Returns the group IDs, one per line, or a note if none are owned.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_member_groups',
    description:
      'List the NOVA groups the authenticated account is a member of (including ' +
      'groups it owns). Takes no arguments; the account is derived from the ' +
      'configured credentials. Returns the group IDs, one per line, or a note ' +
      'if the account belongs to none.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_group_files',
    description:
      'List the file transactions (the audit trail) for a NOVA group: each ' +
      'record ties an uploader, a file hash, and a storage location on-chain. ' +
      'The caller must be authorized on the group. Returns one line per record.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group whose file transactions to list.',
        },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'join_group',
    description:
      'Self-join an OPEN NOVA group (for example a hackathon submission group ' +
      'the organizer has opened for joining). The account joins itself; no owner ' +
      'action is needed, and it only works on groups whose owner has opened a ' +
      'join window. Idempotent: if already a member, it reports that rather than ' +
      'failing. Costs a small NEAR fee (~0.001).',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The open group to join.',
        },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'list_owned_groups') {
    return runTool(async () => {
      const groups = await getSdk().getOwnedGroups();
      if (!Array.isArray(groups) || groups.length === 0) {
        return 'You do not own any NOVA groups yet.';
      }
      return `You own ${groups.length} group(s):\n` + groups.map((g) => `  • ${g}`).join('\n');
    });
  }

  if (name === 'list_member_groups') {
    return runTool(async () => {
      const groups = await getSdk().getMemberGroups();
      if (!Array.isArray(groups) || groups.length === 0) {
        return 'You are not a member of any NOVA groups yet.';
      }
      return `You are a member of ${groups.length} group(s):\n` + groups.map((g) => `  • ${g}`).join('\n');
    });
  }

  if (name === 'list_group_files') {
    const groupId = request.params.arguments?.group_id;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const txs = await getSdk().getTransactionsForGroup(groupId);
      if (!Array.isArray(txs) || txs.length === 0) {
        return `Group '${groupId}' has no file transactions yet.`;
      }
      const lines = txs.map((t, i) => {
        const hash = typeof t.file_hash === 'string' ? t.file_hash.slice(0, 12) : '(no hash)';
        const loc = t.ipfs_hash || '(no location)';
        const who = t.user_id || '(unknown)';
        return `  ${i + 1}. by ${who} — file ${hash}… @ ${loc}`;
      });
      return `Group '${groupId}' has ${txs.length} file transaction(s):\n` + lines.join('\n');
    });
  }

  if (name === 'join_group') {
    const groupId = request.params.arguments?.group_id;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const msg = await getSdk().joinGroup(groupId);
      return typeof msg === 'string' && msg ? msg : `Joined group '${groupId}'.`;
    });
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

// ── Launch on stdio ──────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[nova-plugin] stdio transport connected; awaiting requests\n');
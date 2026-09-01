#!/usr/bin/env node
// @nova-sdk/plugin — local stdio MCP shim for Claude Code and Codex.
//
// ── STDOUT IS RESERVED FOR THE MCP TRANSPORT ────────────────────────────────
// An MCP stdio server MUST write ONLY JSON-RPC protocol messages to stdout; a
// client disconnects (and counts as a crash) any server that writes non-protocol
// output there. nova-sdk-js logs progress with console.log ("🔑 Fetching session
// token…", "✅ …", "⚠️ MAINNET MODE"), which would land on stdout and corrupt the
// stream. Redirect all console.* to STDERR before importing the SDK, so its logs
// (and ours) go to stderr where they belong. The StdioServerTransport writes to
// stdout directly (not via console), so the protocol channel stays clean.
// (This also keeps the SDK's account-id log lines out of stdout — a minor
// PII-hygiene win; the API key is never logged by the SDK or by us.)
for (const m of ['log', 'info', 'debug', 'warn', 'error']) {
  console[m] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
}
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
      'The caller must be authorized on the group. Returns one line per record. ' +
      'Cost note: for a private group this is a signed, paid read (~0.0013 NEAR ' +
      'from the account); for an open/joinable group it is free. Avoid calling ' +
      'it in a tight loop on private groups.',
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
  {
    name: 'register_group',
    description:
      'Create a new NOVA group. The authenticated account becomes the owner and ' +
      'first member, and can then add members and upload files. Cost: this is a ' +
      'paid on-chain operation (~0.05 NEAR) and CANNOT be undone — a group cannot ' +
      'be deleted once created. Only call it when the user explicitly wants a new ' +
      'group; do not create groups speculatively.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'A unique id/name for the new group (e.g. "team-files").',
        },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_group_member',
    description:
      'Grant another NEAR account access to a group. Only the group owner can add ' +
      'members. A bare username is normalized server-side (e.g. "bob" becomes ' +
      '"bob.nova-sdk.near"). Cost: a paid on-chain operation (~0.001 NEAR).',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group to add the member to. Caller must be the owner.',
        },
        member_id: {
          type: 'string',
          description: 'The NEAR account to grant access to.',
        },
      },
      required: ['group_id', 'member_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'revoke_group_member',
    description:
      'Remove a member from a group and rotate the group key so the removed ' +
      'member cannot decrypt files uploaded afterwards. Only the group owner can ' +
      'revoke. Files the member already downloaded stay decryptable (that cannot ' +
      'be undone); only future uploads are protected. Cost: a paid on-chain ' +
      'operation (~0.001 NEAR).',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group to remove the member from. Caller must be the owner.',
        },
        member_id: {
          type: 'string',
          description: 'The NEAR account to revoke.',
        },
      },
      required: ['group_id', 'member_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'store_file',
    description:
      'Encrypt and store a file in a NOVA group. The content is provided as ' +
      'base64 so ANY file type is supported (text, images, PDFs, binary). To ' +
      'store text, base64-encode its UTF-8 bytes. The file is encrypted ' +
      'client-side before it leaves this machine — NOVA never sees the plaintext. ' +
      'The caller must be an authorized member of the group. Max ~4 MB per file. ' +
      'Cost: a paid on-chain operation (~0.003 NEAR). Returns the storage ' +
      'reference (cid), the on-chain transaction id, and the file hash.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group to store the file in. Caller must be a member.',
        },
        filename: {
          type: 'string',
          description: 'A name for the file (e.g. "notes.txt", "report.pdf").',
        },
        content_base64: {
          type: 'string',
          description: 'The file content, base64-encoded. For text, encode its UTF-8 bytes.',
        },
      },
      required: ['group_id', 'filename', 'content_base64'],
      additionalProperties: false,
    },
  },
  {
    name: 'retrieve_file',
    description:
      'Retrieve and decrypt a file from a NOVA group by its storage reference ' +
      '(the "cid" returned by store_file, or a reference from list_group_files). ' +
      'Decryption happens client-side. The caller must be an authorized member. ' +
      'Returns the content as base64; if the bytes are valid UTF-8 text, a text ' +
      'preview is also included for convenience.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'The group the file belongs to. Caller must be a member.',
        },
        cid: {
          type: 'string',
          description: 'The storage reference of the file (from store_file or list_group_files).',
        },
      },
      required: ['group_id', 'cid'],
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

  if (name === 'register_group') {
    const groupId = request.params.arguments?.group_id;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const msg = await getSdk().registerGroup(groupId);
      return typeof msg === 'string' && msg ? msg : `Registered group '${groupId}'.`;
    });
  }

  if (name === 'add_group_member') {
    const groupId = request.params.arguments?.group_id;
    const memberId = request.params.arguments?.member_id;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    if (typeof memberId !== 'string' || memberId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'member_id is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const msg = await getSdk().addGroupMember(groupId, memberId);
      return typeof msg === 'string' && msg ? msg : `Added ${memberId} to group '${groupId}'.`;
    });
  }

  if (name === 'revoke_group_member') {
    const groupId = request.params.arguments?.group_id;
    const memberId = request.params.arguments?.member_id;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    if (typeof memberId !== 'string' || memberId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'member_id is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const msg = await getSdk().revokeGroupMember(groupId, memberId);
      return typeof msg === 'string' && msg ? msg : `Revoked ${memberId} from group '${groupId}'.`;
    });
  }

  if (name === 'store_file') {
    const groupId = request.params.arguments?.group_id;
    const filename = request.params.arguments?.filename;
    const contentB64 = request.params.arguments?.content_base64;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    if (typeof filename !== 'string' || filename.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'filename is required and must be a non-empty string.' }] };
    }
    if (typeof contentB64 !== 'string' || contentB64 === '') {
      return { isError: true, content: [{ type: 'text', text: 'content_base64 is required and must be a non-empty base64 string.' }] };
    }
    // Decode base64 → Buffer. Validate it round-trips, so a malformed base64
    // string is caught here with a clear message rather than silently corrupting.
    let data;
    try {
      data = Buffer.from(contentB64, 'base64');
      if (data.length === 0 || data.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) {
        throw new Error('not valid base64');
      }
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'content_base64 is not valid base64.' }] };
    }
    if (data.length > 4_000_000) {
      return { isError: true, content: [{ type: 'text', text: `File too large: ${data.length} bytes (max 4,000,000). NOVA's per-file cap is ~4 MB.` }] };
    }
    return runTool(async () => {
      const result = await getSdk().upload(groupId, data, filename);
      return (
        `Stored '${filename}' (${data.length} bytes) in group '${groupId}'.\n` +
        `  reference (cid): ${result.cid}\n` +
        `  transaction id: ${result.trans_id}\n` +
        `  file hash (sha256 of plaintext): ${result.file_hash}`
      );
    });
  }

  if (name === 'retrieve_file') {
    const groupId = request.params.arguments?.group_id;
    const cid = request.params.arguments?.cid;
    if (typeof groupId !== 'string' || groupId.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'group_id is required and must be a non-empty string.' }] };
    }
    if (typeof cid !== 'string' || cid.trim() === '') {
      return { isError: true, content: [{ type: 'text', text: 'cid is required and must be a non-empty string.' }] };
    }
    return runTool(async () => {
      const result = await getSdk().retrieve(groupId, cid);
      const buf = Buffer.from(result.data);
      const b64 = buf.toString('base64');
      // Best-effort UTF-8 preview: only if the bytes decode cleanly to valid
      // UTF-8 (round-trip check), so binary files don't emit garbage.
      let preview = null;
      const asText = buf.toString('utf8');
      if (Buffer.from(asText, 'utf8').equals(buf)) {
        preview = asText.length > 4000 ? asText.slice(0, 4000) + '… (truncated)' : asText;
      }
      let out = `Retrieved ${buf.length} bytes from group '${groupId}'.\n  content_base64: ${b64}`;
      if (preview !== null) {
        out += `\n  text_preview:\n${preview}`;
      } else {
        out += `\n  (binary content — no text preview)`;
      }
      return out;
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
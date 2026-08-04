#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// NOVA FastFS Step 0 spike v2 — THROWAWAY. Not production. Proves the primitive.
//
// KEY CORRECTION vs v1: FastFS is NOT a contract. `fastfs.near` has no code.
// A `__fastdata_fastfs` call is EXPECTED to fail on-chain (CodeDoesNotExist);
// an off-chain FastNear indexer reads the action args from block history
// (NEARDATA) and the fastfs.io gateway serves them. So the on-chain result is
// ignored — the GATEWAY is the only source of truth for serve/delete.
//
// Proves, on mainnet, tiny sub-cent files:
//   emit upload action -> gateway serves -> retrieve+decrypt round-trips
//   -> emit delete action (content:null) -> gateway STOPS serving.
// Measures: which arg encoding the indexer accepts (raw borsh vs base64-of-borsh),
//   gas burnt per (failed) action, upload propagation delay, delete propagation.
//
// Does NOT touch the NOVA master seed (throwaway random GCM key). Signer key is
// read from the near-cli keystore, never from terminal/chat/env literal (§10).
//
// Prereqs:  npm i near-api-js@5 borsh@2
//           nova-sdk.near creds in ~/.near-credentials/mainnet/
// Run:      node fastfs-spike.mjs
// ─────────────────────────────────────────────────────────────────────────────

import { connect, keyStores, transactions } from "near-api-js";
import { serialize } from "borsh";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// ── Editable constants ───────────────────────────────────────────────────────
const NETWORK  = "mainnet";
const RPC_URL  = process.env.SPIKE_RPC_URL || "https://rpc.mainnet.near.org";
const SIGNER   = "nova-sdk.near";   // predecessor_id (uploader)
const RECEIVER = "fastfs.near";     // namespace label in the URL; no contract needed
const GATEWAY  = (pred, recv, rel) => `https://${pred}.fastfs.io/${recv}/${rel}`;

const SIZES = [1_024, 65_536, 262_144, 1_048_576]; // plaintext bytes, pre-encryption
// To pin the hard ceiling, add 3_000_000 / 4_000_000 — a tx rejection is the finding.

const SERVE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;
// ─────────────────────────────────────────────────────────────────────────────

// Borsh schema — verified byte-exact against the FastNear doc.
const FastfsSchema = {
  enum: [ { struct: { simple: {
    struct: {
      relativePath: "string",
      content: { option: { struct: {
        mimeType: "string",
        content: { array: { type: "u8" } },
      } } },
    },
  } } } ],
};
const encUpload = (rel, mime, bytes) =>
  serialize(FastfsSchema, { simple: { relativePath: rel, content: { mimeType: mime, content: Array.from(bytes) } } });
const encDelete = (rel) =>
  serialize(FastfsSchema, { simple: { relativePath: rel, content: null } });

// Two candidate wire encodings; the gateway decides which the indexer accepts.
const asRaw    = (b) => Buffer.from(b);
const asBase64 = (b) => Buffer.from(Buffer.from(b).toString("base64"), "utf8");

// AES-256-GCM with a throwaway key — mirrors "FastFS stores opaque ciphertext".
function gcmEncrypt(pt, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(pt), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function gcmDecrypt(blob, key) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

const yoctoToNear = (y) => Number(BigInt(y)) / 1e24;
function burntFrom(o) {
  if (!o) return null;
  try {
    let y = BigInt(o.transaction_outcome?.outcome?.tokens_burnt || "0");
    for (const r of o.receipts_outcome || []) y += BigInt(r.outcome?.tokens_burnt || "0");
    return +yoctoToNear(y.toString()).toFixed(6);
  } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Emit a __fastdata action. The on-chain call is EXPECTED to fail (no contract);
// we swallow that and return whatever gas we can read. Never throws.
async function emit(account, argsBytes) {
  const action = transactions.functionCall("__fastdata_fastfs", argsBytes, 300_000_000_000_000n, 0n);
  try {
    const outcome = await account.signAndSendTransaction({ receiverId: RECEIVER, actions: [action] });
    return { burnt: burntFrom(outcome), note: "on-chain ok (unexpected — indexer still reads it)" };
  } catch (e) {
    // Expected: CompilationError/CodeDoesNotExist. Action + args are still on-chain for the indexer.
    return { burnt: burntFrom(e), note: "on-chain failed as expected (no contract) — action emitted for indexer" };
  }
}

async function pollGateway(url, expect /* "serve"|"gone" */, expectBytes) {
  const t0 = Date.now();
  while (Date.now() - t0 < SERVE_TIMEOUT_MS) {
    let hit = false, matched = false;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (expect === "serve" && res.status === 200) {
        const got = Buffer.from(await res.arrayBuffer());
        matched = expectBytes ? got.equals(expectBytes) : true;
        hit = matched;
      }
      if (expect === "gone" && res.status !== 200) hit = true;
    } catch { /* keep polling */ }
    if (hit) return { ms: Date.now() - t0, matched };
    await sleep(POLL_INTERVAL_MS);
  }
  return { ms: -1, matched: false };
}

async function main() {
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.join(os.homedir(), ".near-credentials"));
  const near = await connect({ networkId: NETWORK, nodeUrl: RPC_URL, keyStore });
  const account = await near.account(SIGNER);

  console.log(`FastFS spike v2 — signer=${SIGNER} receiver=${RECEIVER} net=${NETWORK}`);
  console.log(`Note: on-chain __fastdata calls are EXPECTED to fail; the gateway is the truth.\n`);

  // ── Encoding probe: emit both, keep whichever the gateway ends up serving ──
  let WORKING = null;
  for (const enc of ["raw", "base64"]) {
    const key = crypto.randomBytes(32);
    const blob = gcmEncrypt(crypto.randomBytes(1_024), key);
    const rel = `nova-spike/probe-${enc}-${crypto.randomUUID()}`;
    const url = GATEWAY(SIGNER, RECEIVER, rel);
    const args = (enc === "raw" ? asRaw : asBase64)(encUpload(rel, "application/octet-stream", blob));
    process.stdout.write(`probe encoding=${enc} args=${args.length}B … `);
    const r = await emit(account, args);
    const served = await pollGateway(url, "serve", blob);
    if (served.ms >= 0 && served.matched) {
      console.log(`SERVED in ${served.ms}ms, bytes match ✓  (${r.note})`);
      WORKING = enc;
      await emit(account, (enc === "raw" ? asRaw : asBase64)(encDelete(rel)));
      break;
    }
    console.log(served.ms < 0 ? `not served in ${SERVE_TIMEOUT_MS}ms  (${r.note})` : `served but BYTES MISMATCH`);
  }

  if (!WORKING) {
    console.error("\n✗ Neither encoding served. This is the go/no-go signal — investigate before Step 1:");
    console.error("  • Is the FastFS indexer live and picking up nova-sdk.near → fastfs.near?");
    console.error("  • Does the gateway serve this predecessor subdomain? Try a known-good file.");
    console.error("  • Did NEARDATA see the action? (the tx WILL show 'failed' on an explorer — that's fine)");
    process.exit(1);
  }
  console.log(`\n→ Indexer accepts encoding: ${WORKING}. This sets the real size ceiling.\n`);
  const encode = WORKING === "raw" ? asRaw : asBase64;

  // ── Full round-trip per size ───────────────────────────────────────────────
  const rows = [];
  for (const size of SIZES) {
    const key = crypto.randomBytes(32);
    const plain = crypto.randomBytes(size);
    const blob = gcmEncrypt(plain, key);
    const rel = `nova-spike/${size}-${crypto.randomUUID()}`;
    const url = GATEWAY(SIGNER, RECEIVER, rel);
    const args = encode(encUpload(rel, "application/octet-stream", blob));
    process.stdout.write(`size=${size}B ct=${blob.length}B args=${args.length}B  `);

    const up = await emit(account, args);
    const served = await pollGateway(url, "serve", blob);
    let roundTrip = false;
    if (served.ms >= 0) {
      try {
        const got = Buffer.from(await (await fetch(url, { cache: "no-store" })).arrayBuffer());
        roundTrip = gcmDecrypt(got, key).equals(plain);
      } catch {}
    }
    const del = await emit(account, encode(encDelete(rel)));
    const gone = await pollGateway(url, "gone");

    rows.push({
      size, argsBytes: args.length,
      upBurntNear: up.burnt, delBurntNear: del.burnt,
      serveMs: served.ms, goneMs: gone.ms, roundTrip,
    });
    console.log(`up=${up.burnt}Ⓝ serve=${served.ms}ms rt=${roundTrip ? "✓" : "✗"} del=${del.burnt}Ⓝ gone=${gone.ms}ms`);
  }

  console.log("\n──────── SUMMARY ────────");
  console.log(`indexer-accepted encoding : ${WORKING}`);
  console.table(rows);
  console.log("\nCeiling: NEAR max_transaction_size ≈ 4,194,304 B for the whole signed tx.");
  console.log(`With encoding=${WORKING}, usable payload ≈ that minus tx-envelope/args overhead` +
              `${WORKING === "base64" ? " AND the ×4/3 base64 inflation (so ~3 MB)" : " (so nearly 4 MB)"}.`);
  console.log("Add 3_000_000 / 4_000_000 to SIZES to find the exact reject point.");
  console.log("\nFindings to record:");
  console.log("  • FastFS = off-chain fastdata indexer + gateway; on-chain call fails by design.");
  console.log("  • Deletion = gateway stops serving; bytes persist in NEAR archival history.");
  console.log("    → NOVA deletion guarantee is crypto-shred (destroy file key), not byte-erasure.");
  console.log("  • Serving depends on FastNear infra; self-host fallback = open-source fastdata-indexer.");
}

main().catch((e) => { console.error(e); process.exit(1); });

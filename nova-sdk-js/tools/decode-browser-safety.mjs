// nova/nova-sdk-js/tools/decode-browser-safety.mjs
//
// Phase 0 pre-check (roadmap §6.4) — GATE, re-runnable.
//
// The dashboard's Phase 3 decrypts in the BROWSER: the proxy returns
// { key, encrypted_b64, format } and the browser calls decodeFile(...). This
// gate proves the decode path is browser-safe, by BUILDING it (not reading it):
//
//   1. Bundle ONLY decodeFile for a browser target and capture every bare
//      node built-in the graph pulls in. Assert that set ⊆ the known-safe
//      three: `buffer` (browser-polyfillable), and the runtime-GUARDED dynamic
//      imports `crypto` + `zlib` (never executed when SubtleCrypto /
//      DecompressionStream exist — i.e. never in a browser). Any OTHER builtin
//      is a real Node-only blocker and fails the gate, naming itself.
//
//   2. Prove byte-correct decode on the ACTUAL browser code path. Modern Node
//      exposes globalThis.crypto.subtle + DecompressionStream, so decodeFile
//      takes the SubtleCrypto/WHATWG branch here — the same branch a browser
//      runs — for v0 (legacy IPFS), v1 (FastFS), and v1+deflate.
//
// Run:  node tools/decode-browser-safety.mjs
// Deps: esbuild, buffer  (devDependencies)
//
// Exit 0 = gate green. Non-zero = a blocker; the message says which.
//
// NOTE for Phase 3 consumers (recorded findings, not failures):
//   • Import decodeFile from the SUBPATH 'nova-sdk-js/dist/format.js', NOT the
//     package root — the root drags index.js (@near-js/providers, axios,
//     NovaSdk) into the browser bundle; the browser only needs decode.
//   • The dashboard bundler must polyfill `buffer` and neutralise the guarded
//     `crypto`/`zlib` (Next/webpack: resolve.fallback {crypto:false, zlib:false,
//     buffer:require.resolve('buffer/')} + ProvidePlugin Buffer). Turbopack
//     differs — re-check there.

import esbuild from 'esbuild';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The decode entry the dashboard's browser will use. Subpath import on purpose
// (see NOTE above) — this is also what keeps the bundle to the decode graph.
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
const __gateDir = dirname(fileURLToPath(import.meta.url));
const FORMAT_PATH = resolvePath(__gateDir, '../dist/format.js');
const V0_PATH = resolvePath(__gateDir, '../dist/legacy/v0.js');
const ENTRY = `import { decodeFile } from ${JSON.stringify(FORMAT_PATH)}; globalThis.__d = decodeFile;`;

// Only these may appear as bare node built-ins in a browser-targeted decode
// bundle. `buffer` is a real browser polyfill; `crypto`/`zlib` are dynamic and
// runtime-guarded so they never execute in a browser.
const ALLOWED_BUILTINS = new Set(['buffer', 'crypto', 'node:crypto', 'zlib', 'node:zlib']);

async function step1_bundleAndInventory() {
  const seen = new Set();

  // A plugin that records every bare specifier the bundler cannot resolve to a
  // local file (i.e. node built-ins), and marks it external so the build can
  // complete and report the FULL set rather than dying on the first one.
  const inventory = {
    name: 'builtin-inventory',
    setup(build) {
      // Bare specifiers with no path separator that aren't real packages.
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const id = args.path;
        // Let real, installed packages resolve normally (e.g. the buffer polyfill
        // if aliased). We only want to catch node built-ins here.
        const isBuiltin = [
          'buffer', 'crypto', 'zlib', 'stream', 'util', 'path', 'fs', 'os',
          'http', 'https', 'net', 'tls', 'events', 'assert', 'url', 'querystring',
          'child_process', 'worker_threads', 'perf_hooks', 'vm', 'dns',
        ].some((b) => id === b || id === `node:${b}`);
        if (isBuiltin) {
          seen.add(id.replace(/^node:/, ''));
          return { path: id, external: true };
        }
        return null; // fall through to normal resolution
      });
    },
  };

  await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    plugins: [inventory],
  });

  const extras = [...seen].filter((b) => !ALLOWED_BUILTINS.has(b));
  console.log(`   node built-ins in decode graph: ${[...seen].sort().join(', ') || '(none)'}`);
  assert.strictEqual(
    extras.length,
    0,
    `Node-only blocker(s) on the browser decode path: ${extras.join(', ')}. ` +
      `Only ${[...ALLOWED_BUILTINS].join('/')} are permitted (buffer polyfillable; crypto/zlib guarded).`,
  );
  console.log('✅ step 1: no Node-only blocker — graph uses only buffer + guarded crypto/zlib');
}

async function step2_runtimeSubtleProof() {
  assert(
    typeof globalThis.crypto?.subtle !== 'undefined',
    'globalThis.crypto.subtle absent — cannot prove the browser code path in this runtime',
  );

  const { encodeFile, decodeFile } = await import(FORMAT_PATH);
  const { encryptV0 } = await import(V0_PATH);
  const { Buffer } = await import('buffer');

  const key = Buffer.alloc(32, 7).toString('base64');
  const body = Buffer.from('NOVA dashboard decode proof — '.repeat(200));
  const eq = (a) => Buffer.from(a).equals(body);

  // v0 legacy (absent format ⇒ v0), decoded via subtle.
  assert(eq(await decodeFile(await encryptV0(body, key), key, null)), 'v0 round-trip mismatch');

  // v1 FastFS uncompressed.
  const { bytes_b64: b1, format: f1 } = await encodeFile(body, key);
  assert(eq(await decodeFile(b1, key, f1)), 'v1 uncompressed round-trip mismatch');

  // v1 + deflate (browser CompressionStream/DecompressionStream).
  const { bytes_b64: b2, format: f2 } = await encodeFile(body, key, { compression: 'deflate' });
  assert.strictEqual(f2.compression, 'deflate', 'expected deflate in format');
  assert(eq(await decodeFile(b2, key, f2)), 'v1 deflate round-trip mismatch');

  console.log('✅ step 2: subtle-path decode byte-correct for v0, v1, v1+deflate');
}

(async () => {
  try {
    console.log('Phase 0 pre-check — decode browser-safety gate\n');
    await step1_bundleAndInventory();
    await step2_runtimeSubtleProof();
    console.log('\n✅ GATE GREEN — decodeFile is browser-safe (with buffer polyfill + guarded crypto/zlib).');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ GATE FAILED');
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();
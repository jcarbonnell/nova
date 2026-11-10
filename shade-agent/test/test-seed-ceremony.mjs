// shade-agent/test/test-seed-ceremony.mjs
//
// §5.12 S1b — scripts/seed-ceremony.mjs. Runs the tool as a child process in an
// empty temp directory, with throwaway secrets only. Proves:
//   SC1 a good run writes master-root.args.json, whose blob Shade's decryptBlob
//       opens to the seed; the three printed public keys equal Shade's
//       signerPublicKeyFor() under that seed; NEITHER secret appears anywhere in
//       the output (full value or any 16-char slice)
//   SC2 secret, seed or KV_CONTRACT_ID missing / malformed → refused by name,
//       nothing written
//   SC3 MASTER_SEED equal to TEE_KEY_SECRET → refused, nothing written
//   SC4 an existing master-root.args.json is never overwritten
//   SC5 the printed fingerprints are sha256(value)[0..12]
//
// MUTATIONS (each must turn the named checks ✗):
//   M1 the tool also prints MASTER_SEED                          → SC1
//   M2 the tool encrypts under a constant key, not TEE_KEY_SECRET → SC1
//   M3 the tool drops the existing-file refusal and writes with 'w' → SC4
//   M4 the tool drops the seed ≠ secret check                    → SC3
//
// Build first:  npm run build
// Run:          node ./test/test-seed-ceremony.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../scripts/seed-ceremony.mjs', import.meta.url));
const OUT = 'master-root.args.json';

let pass = 0, fail = 0;
const check = async (name, fn) => {
  try { (await fn()) ? (pass++, console.log(`  ✓ ${name}`))
                     : (fail++, console.log(`  ✗ ${name}`)); }
  catch (e) { fail++; console.log(`  ✗ ${name} — threw: ${e?.message || e}`); }
};
const hex32 = () => crypto.randomBytes(32).toString('hex');
const fp = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

function run(env, prepare) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-ceremony-'));
  if (prepare) prepare(dir);
  const r = spawnSync(process.execPath, [TOOL], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const outFile = path.join(dir, OUT);
  const written = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), written };
}
const leaks = (text, value) => {
  const v = value.toLowerCase(), t = text.toLowerCase();
  for (let i = 0; i + 16 <= v.length; i++) if (t.includes(v.slice(i, i + 16))) return true;
  return false;
};

const SECRET = hex32();
const SEED = hex32();
const KV = 'nova-kv-2.near';
const good = { TEE_KEY_SECRET: SECRET, MASTER_SEED: SEED, KV_CONTRACT_ID: KV };

// Shade's own view of the expected outputs.
process.env.TEE_KEY_SECRET = SECRET;
const { decryptBlob, setMasterSeed } = await import('../dist/lib/crypto.js');
const { signerPublicKeyFor } = await import('../dist/lib/kv.js');

console.log('seed ceremony');

let goodRun;
await check('SC1 good run: blob opens to the seed in Shade, keys = signerPublicKeyFor(), no secret in output', async () => {
  goodRun = run(good);
  if (goodRun.code !== 0 || !goodRun.written) return false;
  const args = JSON.parse(goodRun.written);
  const opened = Buffer.from(decryptBlob(args.encrypted_blob));
  setMasterSeed(new Uint8Array(Buffer.from(SEED, 'hex')));
  const keysOk = (await Promise.all([KV, 'fastfs.near', 'nova-sdk.near'].map(async (r) =>
    goodRun.out.includes(`${r.padEnd(16)} ${await signerPublicKeyFor(r)}`)))).every(Boolean);
  return args.key === 'master-root' && opened.equals(Buffer.from(SEED, 'hex')) && keysOk
    && !leaks(goodRun.out, SECRET) && !leaks(goodRun.out, SEED)
    && !leaks(goodRun.written, SECRET) && !leaks(goodRun.written, SEED);
});

await check('SC5 printed fingerprints are sha256(value)[0..12]', async () =>
  goodRun.out.includes(`TEE_KEY_SECRET fingerprint : ${fp(SECRET)}`)
  && goodRun.out.includes(`MASTER_SEED fingerprint    : ${fp(SEED)}`));

await check('SC2 missing / malformed inputs → refused by name, nothing written', async () => {
  const cases = [
    [{ ...good, TEE_KEY_SECRET: undefined }, 'TEE_KEY_SECRET must be set to 64 hex chars'],
    [{ ...good, TEE_KEY_SECRET: 'ab'.repeat(31) }, 'TEE_KEY_SECRET must be set to 64 hex chars'],
    [{ ...good, MASTER_SEED: 'zz'.repeat(32) }, 'MASTER_SEED must be set to 64 hex chars'],
    [{ ...good, KV_CONTRACT_ID: undefined }, 'KV_CONTRACT_ID must be set'],
  ];
  return cases.every(([env, needle]) => {
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
    const r = run(clean);
    return r.code !== 0 && r.out.includes(`REFUSED: ${needle}`) && r.written === null;
  });
});

await check('SC3 MASTER_SEED equal to TEE_KEY_SECRET → refused, nothing written', async () => {
  const r = run({ ...good, MASTER_SEED: SECRET.toUpperCase() });
  return r.code !== 0 && r.out.includes('REFUSED: MASTER_SEED must differ from TEE_KEY_SECRET') && r.written === null;
});

await check('SC4 an existing master-root.args.json is never overwritten', async () => {
  const r = run(good, (dir) => fs.writeFileSync(path.join(dir, OUT), 'previous run\n'));
  return r.code !== 0 && r.out.includes('already exists') && r.written === 'previous run\n';
});

delete process.env.TEE_KEY_SECRET;
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// shade-agent/src/lib/tee-keys.ts
//
// §5.12 (2026-11 incident rebuild): Shade's root keys come from the TEE, never
// from the environment. Each is derived by the dstack guest agent from the app's
// KMS-held master key (bound to the app_id), one path per purpose:
//
//   nova/kv-encryption/v1 → AES-256-GCM key for KV blobs at rest (replaces TEE_KEY_SECRET)
//   nova/master-seed/v1   → HKDF root for deriveKey() (replaces sponsor-key seed + master-root blob)
//   nova/kv-signer/v1     → ed25519 seed of Shade's scoped signer (replaces deriveKey('kv-owner-signer-v1'))
//
// Fails closed. In production the ONLY source is the real dstack socket:
//   • DSTACK_SIMULATOR_ENDPOINT set in production → refuse (an env change must
//     never be able to redirect key derivation off the TEE);
//   • socket missing → refuse (no fallback key, ever).
// Outside production the dstack simulator is allowed only when explicitly
// requested (NOVA_TEE_SIMULATOR=true + DSTACK_SIMULATOR_ENDPOINT).
//
// No dstack SDK: @phala/dstack-sdk 0.5.8 requires @noble/hashes ^1 as a peer,
// which clashes with Shade's pinned 2.0.1. One RPC (GetKey) is all we need.
//
// Harness: test/test-tee-keys.mjs.

import { existsSync } from 'fs';
import http from 'http';

export const DSTACK_SOCKET = '/var/run/dstack.sock';

export const TEE_KEY_PATHS = Object.freeze({
  kvEncryption: 'nova/kv-encryption/v1',
  masterSeed: 'nova/master-seed/v1',
  kvSigner: 'nova/kv-signer/v1',
});

export interface TeeKeys {
  readonly kvEncryptionKey: Uint8Array; // 32 bytes
  readonly masterSeed: Uint8Array;      // 32 bytes
  readonly kvSignerSeed: Uint8Array;    // 32 bytes (ed25519 seed)
}

/** The one capability this module needs from dstack (lets the harness inject a fake). */
export interface KeySource {
  getKey(path: string): Promise<{ key: Uint8Array }>;
}

export class TeeKeysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeeKeysError';
  }
}

/**
 * Minimal dstack guest-agent client (no SDK): POST /GetKey over the unix socket,
 * or over HTTP to the dstack simulator. Same request the official SDK sends
 * (@phala/dstack-sdk 0.5.8: {path, purpose, algorithm:"secp256k1"} → {key: hex, ...}).
 * Unlike the SDK, it never reads DSTACK_SIMULATOR_ENDPOINT itself.
 */
export function dstackKeySource(endpoint: string, timeoutMs = 30_000): KeySource {
  const viaHttp = endpoint.startsWith('http://');
  return {
    getKey(path: string): Promise<{ key: Uint8Array }> {
      const body = JSON.stringify({ path, purpose: '', algorithm: 'secp256k1' });
      const target = viaHttp ? new URL('/GetKey', endpoint) : null;
      const options: http.RequestOptions = {
        method: 'POST',
        path: target ? target.pathname : '/GetKey',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        ...(target ? { hostname: target.hostname, port: target.port } : { socketPath: endpoint, host: 'dstack' }),
      };
      return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode !== 200) {
              return reject(new TeeKeysError(`dstack GetKey ${path} failed: HTTP ${res.statusCode} ${text.slice(0, 200)}`));
            }
            try {
              const parsed = JSON.parse(text) as { key?: unknown };
              if (typeof parsed.key !== 'string' || !/^[0-9a-fA-F]+$/.test(parsed.key)) {
                return reject(new TeeKeysError(`dstack GetKey ${path}: malformed response`));
              }
              resolve({ key: new Uint8Array(Buffer.from(parsed.key, 'hex')) });
            } catch {
              reject(new TeeKeysError(`dstack GetKey ${path}: response is not JSON`));
            }
          });
        });
        req.on('timeout', () => req.destroy(new TeeKeysError(`dstack GetKey ${path}: timed out`)));
        req.on('error', (e) => reject(e instanceof TeeKeysError ? e : new TeeKeysError(`dstack GetKey ${path}: ${e.message}`)));
        req.end(body);
      });
    },
  };
}

type Env = Record<string, string | undefined>;

/** Choose where keys come from. Production: the real dstack socket, nothing else. */
export function resolveKeySource(
  env: Env = process.env,
  socketExists: (p: string) => boolean = existsSync,
): KeySource {
  const simulator = env.DSTACK_SIMULATOR_ENDPOINT;

  if (env.NODE_ENV === 'production') {
    if (simulator) {
      throw new TeeKeysError(
        'DSTACK_SIMULATOR_ENDPOINT is set in production; refusing to derive keys outside the TEE',
      );
    }
    if (!socketExists(DSTACK_SOCKET)) {
      throw new TeeKeysError(`${DSTACK_SOCKET} not found; refusing to start without the TEE`);
    }
    return dstackKeySource(DSTACK_SOCKET);
  }

  if (env.NOVA_TEE_SIMULATOR !== 'true' || !simulator) {
    throw new TeeKeysError(
      'Outside production, keys come only from the dstack simulator: set NOVA_TEE_SIMULATOR=true ' +
        'and DSTACK_SIMULATOR_ENDPOINT. There is no fallback key.',
    );
  }
  return dstackKeySource(simulator);
}

async function getKey32(source: KeySource, path: string): Promise<Uint8Array> {
  const { key } = await source.getKey(path);
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new TeeKeysError(`dstack returned a ${key?.length ?? 'missing'}-byte key for ${path}; expected 32`);
  }
  return new Uint8Array(key); // own copy
}

/** Derive the three root keys. Distinct paths must yield distinct keys. */
export async function deriveTeeKeys(source: KeySource): Promise<TeeKeys> {
  const [kvEncryptionKey, masterSeed, kvSignerSeed] = await Promise.all([
    getKey32(source, TEE_KEY_PATHS.kvEncryption),
    getKey32(source, TEE_KEY_PATHS.masterSeed),
    getKey32(source, TEE_KEY_PATHS.kvSigner),
  ]);
  const hex = [kvEncryptionKey, masterSeed, kvSignerSeed].map((k) => Buffer.from(k).toString('hex'));
  if (new Set(hex).size !== 3) {
    throw new TeeKeysError('dstack returned the same key for two different paths; refusing to use them');
  }
  return Object.freeze({ kvEncryptionKey, masterSeed, kvSignerSeed });
}

// ── Process-wide instance (loaded once at boot, before serve()) ──

let loaded: TeeKeys | null = null;

export async function loadTeeKeys(source: KeySource = resolveKeySource()): Promise<TeeKeys> {
  if (!loaded) loaded = await deriveTeeKeys(source);
  return loaded;
}

/** Throws until loadTeeKeys() has completed. */
export function getTeeKeys(): TeeKeys {
  if (!loaded) throw new TeeKeysError('TEE keys not loaded; call loadTeeKeys() at boot');
  return loaded;
}

/** Harness only. */
export function _resetTeeKeysForTests(): void {
  loaded = null;
}
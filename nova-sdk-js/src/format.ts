// nova-sdk-js/src/format.ts
//
// File-format versioning (roadmap §5.3). Makes the IPFS→FastFS transition and
// any future format change non-breaking: every file carries a version in its
// (KV-stored, MCP-conveyed) metadata, and the client dispatches to the right
// decoder. Pre-v0.5 files have NO metadata record ⇒ they are v0 and decode via
// the frozen legacy/v0 codec forever.
//
// v1 is deliberately v0's AES-256-GCM with an OPTIONAL deflate step: encode =
// (optionally deflate) then the exact v0 encrypt; decode = v0 decrypt then
// (optionally inflate). No new cipher — the only new surface is compression.
// deflate is cross-environment (WHATWG CompressionStream / Node zlib, both
// RFC1950, verified interchangeable). brotli is schema-allowed but NOT yet
// implemented (browser CompressionStream lacks it) — deferred.

import { Buffer } from 'buffer';
import { encryptV0, decryptV0 } from './legacy/v0.js';
import { NovaError } from './errors.js';

export type CompressionAlgo = 'deflate'; // 'brotli' deferred (no browser CompressionStream support)

export interface FileFormatV1 {
  version: 1;
  backend: 'fastfs' | 'ipfs';
  encryption: 'AES-256-GCM';
  wrapping: 'AES-GCM-keywrap';
  compression?: CompressionAlgo;
  original_size: number;
  content_type: string;
}

// A missing/absent format means v0 (legacy). The union grows with v2, v3, …
export type FileFormat = FileFormatV1;

export interface EncodeOptions {
  compression?: CompressionAlgo;
  content_type?: string;
  backend?: 'fastfs' | 'ipfs';
}

// A Blob won't accept Uint8Array<ArrayBufferLike> (it may be SharedArrayBuffer-
// backed). Copy into a fresh plain-ArrayBuffer view first — same guard v0.ts uses.
function toBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.length));
  copy.set(data);
  return copy;
}

// ── deflate (cross-env: CompressionStream when present, else Node zlib) ──
async function compress(data: Uint8Array, algo: CompressionAlgo): Promise<Uint8Array> {
  if (algo !== 'deflate') {
    throw new NovaError(`compression '${algo}' is not implemented (deflate only; brotli deferred)`);
  }
  const CS = (globalThis as unknown as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof CS !== 'undefined') {
    const stream = new Blob([toBlobPart(data)]).stream().pipeThrough(new CS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const zlib = await import('zlib'); // old-Node fallback (RFC1950, interchangeable with CompressionStream)
  return new Uint8Array(zlib.deflateSync(Buffer.from(data)));
}

async function decompress(data: Uint8Array, algo: CompressionAlgo): Promise<Uint8Array> {
  if (algo !== 'deflate') {
    throw new NovaError(`compression '${algo}' is not implemented (deflate only; brotli deferred)`);
  }
  const DS = (globalThis as unknown as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (typeof DS !== 'undefined') {
    const stream = new Blob([toBlobPart(data)]).stream().pipeThrough(new DS('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const zlib = await import('zlib');
  return new Uint8Array(zlib.inflateSync(Buffer.from(data)));
}

/**
 * Encode a file to the v1 format: optionally deflate, then v0 AES-256-GCM.
 * Returns the base64 ciphertext plus the FileFormatV1 metadata to persist.
 * `backend` is informational here (Shade/MCP set the authoritative value at
 * upload); it defaults to 'fastfs'.
 */
export async function encodeFile(
  data: Buffer,
  keyB64: string,
  opts: EncodeOptions = {},
): Promise<{ bytes_b64: string; format: FileFormatV1 }> {
  const original_size = data.length;

  let payload: Buffer = data;
  if (opts.compression) {
    payload = Buffer.from(await compress(new Uint8Array(data), opts.compression));
  }

  const bytes_b64 = await encryptV0(payload, keyB64); // reuse the frozen v0 AES-GCM layout

  const format: FileFormatV1 = {
    version: 1,
    backend: opts.backend ?? 'fastfs',
    encryption: 'AES-256-GCM',
    wrapping: 'AES-GCM-keywrap',
    original_size,
    content_type: opts.content_type ?? 'application/octet-stream',
    ...(opts.compression ? { compression: opts.compression } : {}),
  };

  return { bytes_b64, format };
}

/**
 * Decode a file, dispatching on its format version. Absent/null format ⇒ v0
 * (legacy). An unknown version throws rather than silently mis-decoding.
 */
export async function decodeFile(
  bytesB64: string,
  keyB64: string,
  format?: FileFormat | null,
): Promise<Buffer> {
  const version = format?.version ?? 0;

  if (version === 0) {
    return decryptV0(bytesB64, keyB64);
  }

  if (version === 1) {
    const payload = await decryptV0(bytesB64, keyB64); // same AES-GCM layout as v0
    if (format!.compression) {
      return Buffer.from(await decompress(new Uint8Array(payload), format!.compression));
    }
    return payload;
  }

  throw new NovaError(`Unsupported file format version: ${version}`);
}

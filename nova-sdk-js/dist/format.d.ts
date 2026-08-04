import { Buffer } from 'buffer';
export type CompressionAlgo = 'deflate';
export interface FileFormatV1 {
    version: 1;
    backend: 'fastfs' | 'ipfs';
    encryption: 'AES-256-GCM';
    wrapping: 'AES-GCM-keywrap';
    compression?: CompressionAlgo;
    original_size: number;
    content_type: string;
}
export type FileFormat = FileFormatV1;
export interface EncodeOptions {
    compression?: CompressionAlgo;
    content_type?: string;
    backend?: 'fastfs' | 'ipfs';
}
/**
 * Encode a file to the v1 format: optionally deflate, then v0 AES-256-GCM.
 * Returns the base64 ciphertext plus the FileFormatV1 metadata to persist.
 * `backend` is informational here (Shade/MCP set the authoritative value at
 * upload); it defaults to 'fastfs'.
 */
export declare function encodeFile(data: Buffer, keyB64: string, opts?: EncodeOptions): Promise<{
    bytes_b64: string;
    format: FileFormatV1;
}>;
/**
 * Decode a file, dispatching on its format version. Absent/null format ⇒ v0
 * (legacy). An unknown version throws rather than silently mis-decoding.
 */
export declare function decodeFile(bytesB64: string, keyB64: string, format?: FileFormat | null): Promise<Buffer>;
//# sourceMappingURL=format.d.ts.map
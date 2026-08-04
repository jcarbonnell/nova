"use strict";
// nova-sdk-js/src/legacy/v0.ts
//
// FROZEN v0 codec — the pre-v0.5 on-the-wire file format. THIS FILE NEVER CHANGES.
// Every file uploaded before file-format versioning (roadmap §5.3) is v0, and
// this decoder must decode them for the lifetime of the product. Moved verbatim
// out of index.ts; do not "modernise" it — its exact behaviour is the compat
// contract.
//
// Layout: base64( IV(12) || ciphertext || authTag(16) ), AES-256-GCM.
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptV0 = encryptV0;
exports.decryptV0 = decryptV0;
const buffer_1 = require("buffer");
// encryption helpers (AES-256-GCM) — v0 wire format
async function encryptV0(data, keyB64) {
    // Node.js environment
    if (typeof globalThis.crypto?.subtle === 'undefined') {
        const crypto = await import('crypto');
        const keyBytes = buffer_1.Buffer.from(keyB64, 'base64');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv);
        const encrypted = buffer_1.Buffer.concat([cipher.update(data), cipher.final()]);
        const authTag = cipher.getAuthTag();
        // Format: IV (12) + ciphertext + authTag (16)
        const result = buffer_1.Buffer.concat([iv, encrypted, authTag]);
        return result.toString('base64');
    }
    // Browser/Deno: use SubtleCrypto
    const keyBytes = new Uint8Array(buffer_1.Buffer.from(keyB64, 'base64'));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    // Create a plain ArrayBuffer copy to avoid TypeScript issues with Buffer's ArrayBufferLike
    const dataArrayBuffer = new ArrayBuffer(data.length);
    const dataView = new Uint8Array(dataArrayBuffer);
    for (let i = 0; i < data.length; i++) {
        dataView[i] = data[i];
    }
    const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, dataArrayBuffer);
    // Combine IV + ciphertext (which includes auth tag in SubtleCrypto)
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return buffer_1.Buffer.from(result).toString('base64');
}
async function decryptV0(encryptedB64, keyB64) {
    const encryptedBytes = buffer_1.Buffer.from(encryptedB64, 'base64');
    const keyBytes = buffer_1.Buffer.from(keyB64, 'base64');
    // For Node.js environment
    if (typeof globalThis.crypto?.subtle === 'undefined') {
        const crypto = await import('crypto');
        const iv = encryptedBytes.subarray(0, 12);
        const authTag = encryptedBytes.subarray(encryptedBytes.length - 16);
        const ciphertext = encryptedBytes.subarray(12, encryptedBytes.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
        decipher.setAuthTag(authTag);
        const decrypted = buffer_1.Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted;
    }
    // Browser/Deno: use SubtleCrypto
    const iv = encryptedBytes.subarray(0, 12);
    const ciphertext = encryptedBytes.subarray(12); // Includes auth tag
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
    return buffer_1.Buffer.from(decrypted);
}

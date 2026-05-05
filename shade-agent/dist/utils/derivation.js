import crypto from 'crypto';
import * as ed25519 from '@noble/ed25519';
import bs58 from 'bs58';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
// TEE secret for blob encryption
const TEE_SECRET = process.env.TEE_KEY_SECRET;
if (!TEE_SECRET) {
    throw new Error('TEE_KEY_SECRET environment variable is required');
}
const TEE_KEY_BUFFER = Buffer.from(TEE_SECRET, 'hex');
if (TEE_KEY_BUFFER.length !== 32) {
    throw new Error('TEE_KEY_SECRET must be 32 bytes (64 hex characters)');
}
// Master seed (loaded externally)
let masterSeed = null;
// Enclave signer keypair
let enclaveSigner = null;
/**
 * Set the master seed (called by initialization code)
 */
export function setMasterSeed(seed) {
    masterSeed = seed;
    console.log('✅ Master seed set');
}
/**
 * Initialize enclave signer from master seed
 */
export async function initializeEnclaveSigner() {
    if (enclaveSigner) {
        console.log('✓ Enclave signer already initialized');
        return;
    }
    if (!masterSeed) {
        throw new Error('Master seed not set. Call setMasterSeed() first.');
    }
    const signerSeed = deriveKey('enclave-signer', 32);
    enclaveSigner = {
        privateKey: signerSeed,
        publicKey: await ed25519.getPublicKeyAsync(signerSeed),
    };
    const publicKeyBs58 = bs58.encode(enclaveSigner.publicKey);
    console.log('✅ Enclave signer initialized');
    console.log(`   Account: kv-signer.nova-kv.near`);
    console.log(`   Public key: ed25519:${publicKeyBs58}`);
}
/**
 * Derive a key from master seed using HKDF-SHA256
 */
export function deriveKey(salt, length = 32) {
    if (!masterSeed) {
        throw new Error('Master seed not initialized');
    }
    return hkdf(sha256, masterSeed, new TextEncoder().encode(salt), new TextEncoder().encode('nova-v1'), length);
}
/**
 * Encrypt data with TEE_KEY_SECRET (AES-256-CBC)
 */
export function encryptBlob(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', TEE_KEY_BUFFER, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}
/**
 * Decrypt data encrypted with encryptBlob
 */
export function decryptBlob(enc) {
    const [ivStr, encStr] = enc.split(':');
    if (!ivStr || !encStr) {
        throw new Error('Invalid encrypted blob format');
    }
    const iv = Buffer.from(ivStr, 'hex');
    const encrypted = Buffer.from(encStr, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', TEE_KEY_BUFFER, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return new Uint8Array(decrypted);
}
/**
 * Get the enclave signer keypair
 */
export function getEnclaveSigner() {
    if (!enclaveSigner) {
        throw new Error('Enclave signer not initialized');
    }
    return enclaveSigner;
}

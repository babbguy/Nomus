import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Encrypt a string value using AES-256-GCM.
 * Returns a base64-encoded string containing IV + authTag + ciphertext.
 */
export function encryptValue(plaintext: string): string {
  const secret = createHash('sha256').update(env().NOMUS_SIGNING_KEY_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

/**
 * Decrypt a value previously encrypted with encryptValue().
 * Input is the base64-encoded string from encryptValue.
 */
export function decryptValue(encoded: string): string {
  const secret = createHash('sha256').update(env().NOMUS_SIGNING_KEY_SECRET).digest();
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', secret, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

/** Prefix used to identify encrypted values in storage */
export const ENCRYPTED_PREFIX = 'enc:';

/** Encrypt a value and prepend the encrypted prefix */
export function encryptForStorage(plaintext: string): string {
  return ENCRYPTED_PREFIX + encryptValue(plaintext);
}

/** Decrypt a storage value — returns plaintext whether or not it was encrypted */
export function decryptFromStorage(value: string): string {
  if (value.startsWith(ENCRYPTED_PREFIX)) {
    return decryptValue(value.slice(ENCRYPTED_PREFIX.length));
  }
  // Not encrypted (legacy) — return as-is
  return value;
}

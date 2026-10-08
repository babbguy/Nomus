import {
  generateKeyPairSync,
  sign,
  verify,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  randomUUID,
} from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { stateHashes } from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

let _privateKey: Buffer | null = null;
let _publicKey: Buffer | null = null;

const SIGNING_KEY_MARKER = 'SIGNING_KEY';

/**
 * Initialize or load the Ed25519 signing keypair.
 * Private key is encrypted at rest using AES-256-GCM.
 */
export function initSigningKeys(): { publicKey: string } {
  const db = getDb();

  // Look for existing key record
  const allHashes = db.select().from(stateHashes).all();
  const keyRecord = allHashes.find((r) => r.hash.startsWith(`${SIGNING_KEY_MARKER}:`));

  if (keyRecord) {
    const parts = keyRecord.hash.split(':');
    const encryptedData = Buffer.from(parts[1], 'base64');
    const iv = encryptedData.subarray(0, 12);
    const authTag = encryptedData.subarray(12, 28);
    const ciphertext = encryptedData.subarray(28);
    const pubKeyHex = parts[2];

    const secret = createHash('sha256').update(env().NOMUS_SIGNING_KEY_SECRET).digest();
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(authTag);
    _privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    _publicKey = Buffer.from(pubKeyHex, 'hex');

    return { publicKey: _publicKey.toString('base64') };
  }

  // Generate new Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  _privateKey = Buffer.from(privateKey);
  _publicKey = Buffer.from(publicKey);

  // Encrypt private key with AES-256-GCM
  const secret = createHash('sha256').update(env().NOMUS_SIGNING_KEY_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const encrypted = Buffer.concat([cipher.update(_privateKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedPayload = Buffer.concat([iv, authTag, encrypted]).toString('base64');

  // Persist encrypted key
  db.insert(stateHashes).values({
    id: randomUUID(),
    hash: `${SIGNING_KEY_MARKER}:${encryptedPayload}:${_publicKey.toString('hex')}`,
    ruleCount: 0,
    computedAt: new Date().toISOString(),
  }).run();

  logger.info('Ed25519 signing keypair generated and stored');
  return { publicKey: _publicKey.toString('base64') };
}

/**
 * Sign data with the Ed25519 private key.
 */
export function signData(data: string): string {
  if (!_privateKey) throw new Error('Signing keys not initialized');
  const signature = sign(null, Buffer.from(data), {
    key: _privateKey,
    format: 'der',
    type: 'pkcs8',
  });
  return signature.toString('base64');
}

/**
 * Verify a signature against the public key.
 */
export function verifySignature(data: string, signature: string): boolean {
  if (!_publicKey) throw new Error('Signing keys not initialized');
  return verify(null, Buffer.from(data), {
    key: _publicKey,
    format: 'der',
    type: 'spki',
  }, Buffer.from(signature, 'base64'));
}

/**
 * Get the public key in base64 (for .well-known endpoint).
 */
export function getPublicKey(): string {
  if (!_publicKey) throw new Error('Signing keys not initialized');
  return _publicKey.toString('base64');
}

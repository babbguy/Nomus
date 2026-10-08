/**
 * GET /.well-known/nomus-keys must publish an RFC 8037 OKP/Ed25519 JWK whose
 * `x` is the base64url raw 32-byte public key, so standard libraries (Node's
 * createPublicKey, Python cryptography via from_public_bytes) can import it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';

import { initSigningKeys, getPublicKey, signData } from '../../core/signing.js';
import { runMigrations } from '../../db/migrate.js';
import { createApp } from '../app.js';

const app = createApp();

beforeAll(() => {
  runMigrations();
  initSigningKeys();
});

describe('GET /.well-known/nomus-keys', () => {
  it('publishes an RFC 8037 JWK that standard libraries import', async () => {
    const res = await app.request('http://localhost/.well-known/nomus-keys');
    expect(res.status).toBe(200);
    const jwk = (await res.json() as { keys: Record<string, string>[] }).keys[0];

    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(jwk.x, 'base64url')).toHaveLength(32);

    const imported = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    const engineKey = createPublicKey({ key: Buffer.from(getPublicKey(), 'base64'), format: 'der', type: 'spki' });
    expect(imported.equals(engineKey)).toBe(true);

    // The spki member matches the evidence-bundle encoding; kid is unchanged.
    expect(jwk.spki).toBe(getPublicKey());
    expect(jwk.kid).toBe(createHash('sha256').update(getPublicKey()).digest('hex').slice(0, 16));

    // Engine-signed data verifies with the JWK-imported key.
    const data = 'nomus jwks regression payload';
    expect(verify(null, Buffer.from(data), imported, Buffer.from(signData(data), 'base64'))).toBe(true);
  });
});

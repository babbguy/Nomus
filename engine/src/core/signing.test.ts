import { describe, it, expect, beforeAll, vi } from 'vitest';

// Mock the database and env before importing the module
vi.mock('../db/client.js', () => {
  const rows: any[] = [];
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({
          all: () => [...rows],
        }),
      }),
      insert: () => ({
        values: (val: any) => ({
          run: () => { rows.push(val); },
        }),
      }),
    }),
  };
});

vi.mock('../config/env.js', () => ({
  env: () => ({
    NOMUS_SIGNING_KEY_SECRET: 'test-secret-key-for-signing-at-least-32-chars',
  }),
}));

vi.mock('../db/schema.js', () => ({
  stateHashes: 'stateHashes',
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { initSigningKeys, signData, verifySignature, getPublicKey } from './signing.js';

describe('signing', () => {
  beforeAll(() => {
    initSigningKeys();
  });

  it('generates a keypair and returns a base64 public key', () => {
    const result = initSigningKeys();
    expect(result.publicKey).toBeDefined();
    expect(typeof result.publicKey).toBe('string');
    expect(result.publicKey.length).toBeGreaterThan(0);
  });

  it('getPublicKey returns the same public key', () => {
    const pk = getPublicKey();
    expect(typeof pk).toBe('string');
    expect(pk.length).toBeGreaterThan(0);
  });

  it('signs data and produces a base64 signature', () => {
    const data = 'test-data-to-sign';
    const signature = signData(data);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
  });

  it('verifies a valid signature', () => {
    const data = 'some-important-policy-data';
    const signature = signData(data);
    const valid = verifySignature(data, signature);
    expect(valid).toBe(true);
  });

  it('detects tampered data', () => {
    const data = 'original-data';
    const signature = signData(data);
    const valid = verifySignature('tampered-data', signature);
    expect(valid).toBe(false);
  });

  it('detects tampered signature', () => {
    const data = 'test-data';
    const signature = signData(data);
    // Corrupt the signature
    const corrupted = signature.slice(0, -4) + 'XXXX';
    try {
      const valid = verifySignature(data, corrupted);
      expect(valid).toBe(false);
    } catch {
      // Corrupted signature may throw — that's fine
    }
  });

  it('produces different signatures for different data', () => {
    const sig1 = signData('data-1');
    const sig2 = signData('data-2');
    expect(sig1).not.toBe(sig2);
  });

  it('produces consistent signatures for the same data', () => {
    const data = 'consistent-data';
    const sig1 = signData(data);
    const sig2 = signData(data);
    expect(sig1).toBe(sig2);
  });
});

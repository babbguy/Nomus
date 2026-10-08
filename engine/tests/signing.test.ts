import { describe, it, expect, beforeAll } from 'vitest';
// Test env vars loaded from .env.test via vitest setupFiles

import { initSigningKeys, signData, verifySignature, getPublicKey } from '../src/core/signing.js';
import { createTestTables } from './setup.js';

describe('Ed25519 Signing', () => {
  beforeAll(() => {
    createTestTables();
    initSigningKeys();
  });

  it('generates a public key on init', () => {
    const pubKey = getPublicKey();
    expect(pubKey).toBeDefined();
    expect(pubKey.length).toBeGreaterThan(10);
  });

  it('signs data and returns base64 signature', () => {
    const sig = signData('hello world');
    expect(sig).toBeDefined();
    expect(sig.length).toBeGreaterThan(10);
    // Ed25519 signatures are 64 bytes = 88 base64 chars
    expect(Buffer.from(sig, 'base64').length).toBe(64);
  });

  it('verifies valid signatures', () => {
    const data = 'test data for verification';
    const sig = signData(data);
    expect(verifySignature(data, sig)).toBe(true);
  });

  it('rejects invalid signatures', () => {
    const data = 'original data';
    const sig = signData(data);
    expect(verifySignature('tampered data', sig)).toBe(false);
  });

  it('rejects corrupted signatures', () => {
    const data = 'test data';
    const sig = signData(data);
    const corrupted = sig.slice(0, -4) + 'AAAA';
    expect(verifySignature(data, corrupted)).toBe(false);
  });

  it('produces different signatures for different data', () => {
    const sig1 = signData('data one');
    const sig2 = signData('data two');
    expect(sig1).not.toBe(sig2);
  });

  it('produces deterministic signatures for same data', () => {
    const sig1 = signData('deterministic test');
    const sig2 = signData('deterministic test');
    expect(sig1).toBe(sig2);
  });
});

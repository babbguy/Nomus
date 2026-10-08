/**
 * Attestation lifecycle: status derivation matrix + signature
 * verification helpers.
 *
 * deriveAttestationStatus is the SINGLE pure function every surface (public
 * verify, authed verify, export, notifier) uses — this matrix is the
 * authoritative spec of its precedence: revoked > superseded > expired > valid.
 *
 * Uses the real engine DB (:memory: per .env.test; vitest isolates this
 * file's process) and the real Ed25519 signing path for the round-trip tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { organizations, attestationReceipts } from '../db/schema.js';
import { initSigningKeys } from './signing.js';
import { evaluateCompliance } from './attestation.js';
import {
  deriveAttestationStatus,
  buildSignedReceiptPayload,
  verifyReceiptSignature,
  ATTESTATION_SCHEMA_VERSION,
} from './attestation-lifecycle.js';

const NOW = '2026-07-25T12:00:00.000Z';
const PAST = '2026-07-01T00:00:00.000Z';
const FUTURE = '2027-01-01T00:00:00.000Z';

function fields(over: Partial<{ revokedAt: string | null; supersededBy: string | null; expiresAt: string | null }> = {}) {
  return { revokedAt: null, supersededBy: null, expiresAt: null, ...over };
}

describe('deriveAttestationStatus — precedence matrix', () => {
  const matrix: Array<[string, Parameters<typeof deriveAttestationStatus>[0], string]> = [
    ['no lifecycle fields set → valid', fields(), 'valid'],
    ['future expiry only → valid', fields({ expiresAt: FUTURE }), 'valid'],
    ['past expiry only → expired', fields({ expiresAt: PAST }), 'expired'],
    ['superseded only → superseded', fields({ supersededBy: 'other-id' }), 'superseded'],
    ['revoked only → revoked', fields({ revokedAt: PAST }), 'revoked'],
    ['revoked beats superseded', fields({ revokedAt: PAST, supersededBy: 'x' }), 'revoked'],
    ['revoked beats expired', fields({ revokedAt: PAST, expiresAt: PAST }), 'revoked'],
    ['revoked beats everything', fields({ revokedAt: PAST, supersededBy: 'x', expiresAt: PAST }), 'revoked'],
    ['superseded beats expired', fields({ supersededBy: 'x', expiresAt: PAST }), 'superseded'],
    ['superseded with future expiry → superseded', fields({ supersededBy: 'x', expiresAt: FUTURE }), 'superseded'],
  ];

  for (const [name, input, expected] of matrix) {
    it(name, () => {
      expect(deriveAttestationStatus(input, NOW)).toBe(expected);
    });
  }

  it('expiry boundary: expiresAt exactly equal to now is NOT yet expired', () => {
    expect(deriveAttestationStatus(fields({ expiresAt: NOW }), NOW)).toBe('valid');
    expect(deriveAttestationStatus(fields({ expiresAt: NOW }), '2026-07-25T12:00:00.001Z')).toBe('expired');
  });

  it('is deterministic for a given instant (reproducible)', () => {
    const f = fields({ expiresAt: '2026-07-25T12:30:00.000Z' });
    expect(deriveAttestationStatus(f, '2026-07-25T12:00:00.000Z')).toBe('valid');
    expect(deriveAttestationStatus(f, '2026-07-25T12:00:00.000Z')).toBe('valid');
    expect(deriveAttestationStatus(f, '2026-07-25T13:00:00.000Z')).toBe('expired');
  });

  it('fails closed on garbage expiresAt (never clean on bad data)', () => {
    expect(deriveAttestationStatus(fields({ expiresAt: 'not-a-date' }), NOW)).toBe('expired');
  });

  it('fails closed on garbage evaluation instant', () => {
    expect(deriveAttestationStatus(fields({ expiresAt: FUTURE }), 'garbage')).toBe('expired');
  });
});

// ─── Signature helpers (real DB + real Ed25519) ────────────────

describe('receipt signature verification', () => {
  let orgId: string;

  beforeAll(() => {
    runMigrations();
    initSigningKeys();
    const db = getDb();
    orgId = randomUUID();
    const now = new Date().toISOString();
    db.insert(organizations).values({
      id: orgId,
      name: 'Sig Test Org',
      slug: `sig-test-${orgId.slice(0, 8)}`,
      jurisdictionAccess: '[]',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }).run();
  });

  it('a freshly created attestation verifies, and carries schemaVersion 1', () => {
    const result = evaluateCompliance(orgId, { action: 'test' }, 'EU');
    expect(result.schemaVersion).toBe(ATTESTATION_SCHEMA_VERSION);

    const db = getDb();
    const row = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, result.id)).get()!;
    expect(row.schemaVersion).toBe(1);
    expect(verifyReceiptSignature(row)).toBe(true);
  });

  it('a tampered result no longer verifies', () => {
    const result = evaluateCompliance(orgId, { action: 'test' }, 'EU');
    const db = getDb();
    db.update(attestationReceipts)
      .set({ result: 'non_compliant' })
      .where(eq(attestationReceipts.id, result.id)).run();
    const row = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, result.id)).get()!;
    // Precondition: we actually flipped the stored result
    expect(row.result).not.toBe(result.result);
    expect(verifyReceiptSignature(row)).toBe(false);
  });

  it('a corrupted (non-JSON) actionContext yields payload null and signatureValid false — never throws', () => {
    const result = evaluateCompliance(orgId, { action: 'test' }, 'EU');
    const db = getDb();
    db.update(attestationReceipts)
      .set({ actionContext: '{not json' })
      .where(eq(attestationReceipts.id, result.id)).run();
    const row = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, result.id)).get()!;
    expect(buildSignedReceiptPayload(row)).toBeNull();
    expect(verifyReceiptSignature(row)).toBe(false);
  });

  it('revoking does NOT invalidate the signature — status and signature are separate', () => {
    const result = evaluateCompliance(orgId, { action: 'test' }, 'EU');
    const db = getDb();
    const revokedAt = new Date().toISOString();
    db.update(attestationReceipts)
      .set({ revokedAt, revocationReason: 'test revocation' })
      .where(eq(attestationReceipts.id, result.id)).run();
    const row = db.select().from(attestationReceipts)
      .where(eq(attestationReceipts.id, result.id)).get()!;
    expect(verifyReceiptSignature(row)).toBe(true);
    expect(deriveAttestationStatus(row, new Date().toISOString())).toBe('revoked');
  });
});

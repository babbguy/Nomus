/**
 * Backward compatibility of attestation evidence (design spec §13.1, §16.8).
 * __fixtures__/evidence-v1.1.0.json was exported by the unmodified v1.1.0
 * builder, together with the rows it was built from (a test-only signing key,
 * encrypted under the committed test secret). Replaying those rows, today's
 * export must be byte-identical, and the bundle must verify with the v1.2.0
 * offline verifier.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { attestationReceipts } from '../../db/schema.js';
import { runMigrations } from '../../db/migrate.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { initSigningKeys, getPublicKey } from '../../core/signing.js';
import { verifyReceiptSignature } from '../../core/attestation-lifecycle.js';
import { verifyEvidenceBundle } from '../../cpg/attestations/verify.js';
import { call, makeKey } from '../../cpg/__fixtures__/rbac-fixtures.js';
import { createApp } from '../app.js';

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '__fixtures__/evidence-v1.1.0.json'), 'utf8')) as {
  rows: Record<string, Array<Record<string, unknown>>>;
  bundle: Record<string, any>;
};
const receipt = fixture.rows.attestation_receipts[0];

beforeAll(() => {
  runMigrations();
  const sqlite = rawSqlite(getDb());
  for (const [table, rows] of Object.entries(fixture.rows)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      sqlite.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    }
  }
  initSigningKeys(); // loads the fixture key from state_hashes
});

describe('v1.1.0 evidence bundles', () => {
  it('the fixture key is the instance key, and the stored receipt still verifies', () => {
    expect(getPublicKey()).toBe(fixture.bundle.verification.publicKey);
    const stored = getDb().select().from(attestationReceipts).where(eq(attestationReceipts.id, String(receipt.id))).get()!;
    expect(verifyReceiptSignature(stored)).toBe(true);
  });

  it('an attestation without a governance manifest exports byte-identical to v1.1.0', async () => {
    const { key } = makeKey(String(receipt.org_id), null);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fixture.bundle.generatedAt));
    try {
      const res = await call(createApp(), 'GET', `/api/v1/attestations/${receipt.id}/export?format=json`, { bearer: key });
      expect(res.status).toBe(200);
      expect(res.text).toBe(JSON.stringify(fixture.bundle, null, 2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('verifies offline with the v1.2.0 verifier, and any edit is rejected', () => {
    const spki = fixture.bundle.verification.publicKey as string;
    expect(verifyEvidenceBundle(fixture.bundle, spki)).toEqual({ ok: true, reasons: [] });
    const edited = structuredClone(fixture.bundle);
    edited.verification.signedPayloadCanonicalJson = edited.verification.signedPayloadCanonicalJson.replace('"requires_review"', '"compliant"');
    edited.attestation.result = 'compliant';
    expect(verifyEvidenceBundle(edited, spki).reasons).toContain('the receipt signature does not verify');
    expect(verifyEvidenceBundle({ ...fixture.bundle, bundleVersion: 2 }, spki).ok).toBe(false);
  });
});

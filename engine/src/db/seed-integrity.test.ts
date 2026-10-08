/**
 * Rule signatures on a freshly seeded database.
 *
 * Every seeded rule must verify, re-running the seed (every engine start) must
 * keep it that way, and a rule whose content changed without re-signing must
 * still be reported rather than silently re-signed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb } from './client.js';
import { runMigrations } from './migrate.js';
import { seedDatabase } from './seed.js';
import { policyRules } from './schema.js';
import { initSigningKeys } from '../core/signing.js';
import { signRule, verifyRuleSignature, UNSIGNED } from '../core/rule-signing.js';
import { verifyIntegrity } from '../audit/integrity.js';

describe('seeded rule signatures', () => {
  beforeAll(async () => {
    runMigrations();
    initSigningKeys();
    await seedDatabase();
  });

  it('signs every seeded rule so the integrity check passes', () => {
    const rules = getDb().select().from(policyRules).all();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((r) => r.signature === UNSIGNED)).toEqual([]);

    const result = verifyIntegrity();
    expect(result.corrupted).toEqual([]);
    expect(result.valid).toBe(result.total);
  });

  it('stays valid when the seed runs again on the next start', async () => {
    await seedDatabase();
    expect(verifyIntegrity().corrupted).toEqual([]);
  });

  it('still reports a rule edited without re-signing', async () => {
    const db = getDb();
    const rule = db.select().from(policyRules).where(eq(policyRules.isActive, true)).get()!;
    db.update(policyRules)
      .set({ humanSummary: `${rule.humanSummary} (tampered)` })
      .where(eq(policyRules.id, rule.id))
      .run();

    await seedDatabase();
    expect(verifyIntegrity().corrupted).toContain(rule.ruleKey);

    // Restore so other assertions in this file see a clean database.
    db.update(policyRules)
      .set({ humanSummary: rule.humanSummary })
      .where(eq(policyRules.id, rule.id))
      .run();
    expect(verifyIntegrity().corrupted).toEqual([]);
  });

  it('verifies a new version signed through signRule', () => {
    const rule = getDb().select().from(policyRules).get()!;
    const next = { ...rule, version: rule.version + 1 };
    expect(verifyRuleSignature({ ...next, signature: signRule(next) })).toBe(true);
    expect(verifyRuleSignature({ ...next, signature: rule.signature })).toBe(false);
  });
});

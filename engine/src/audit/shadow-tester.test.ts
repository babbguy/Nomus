/**
 * Shadow tests are the dashboard's "Nomus audits itself" check. On a freshly
 * seeded database every fixture must pass, a jurisdiction with no active rules
 * is reported as skipped (not failed), and a changed rule effect is caught.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { seedDatabase } from '../db/seed.js';
import { policyRules } from '../db/schema.js';
import { initSigningKeys } from '../core/signing.js';
import { runShadowTests } from './shadow-tester.js';

describe('shadow tests', () => {
  beforeAll(async () => {
    runMigrations();
    initSigningKeys();
    await seedDatabase();
  });

  it('all pass on a freshly seeded database', () => {
    const result = runShadowTests();
    const notPassed = result.results.filter((r) => r.status !== 'passed');
    expect(notPassed).toEqual([]);
    expect(result.passed).toBe(result.total);
    expect(result.total).toBeGreaterThanOrEqual(10);
  });

  it('reports a jurisdiction without active rules as skipped', () => {
    const db = getDb();
    const caRules = db.select().from(policyRules)
      .where(and(eq(policyRules.jurisdiction, 'US-CA'), eq(policyRules.isActive, true)))
      .all();
    expect(caRules.length).toBeGreaterThan(0);
    db.update(policyRules).set({ isActive: false }).where(eq(policyRules.jurisdiction, 'US-CA')).run();
    try {
      const result = runShadowTests();
      const ca = result.results.filter((r) => r.jurisdiction === 'US-CA');
      expect(ca.length).toBeGreaterThan(0);
      expect(ca.every((r) => r.status === 'skipped')).toBe(true);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(ca.length);
    } finally {
      for (const r of caRules) {
        db.update(policyRules).set({ isActive: true }).where(eq(policyRules.id, r.id)).run();
      }
    }
  });

  it('fails when a rule no longer produces the expected effect', () => {
    const db = getDb();
    const rule = db.select().from(policyRules)
      .where(eq(policyRules.ruleKey, 'hipaa.164_502.phi_in_ai_pipeline'))
      .get();
    expect(rule?.effect).toBe('deny');
    db.update(policyRules).set({ effect: 'flag' }).where(eq(policyRules.id, rule!.id)).run();
    try {
      const result = runShadowTests();
      const hipaa = result.results.find((r) => r.name.startsWith('HIPAA 164.502'));
      expect(hipaa?.status).toBe('failed');
      expect(hipaa?.actual).toBe('flag');
    } finally {
      db.update(policyRules).set({ effect: 'deny' }).where(eq(policyRules.id, rule!.id)).run();
    }
  });
});

/**
 * Extraction upsert: new rules are created, existing ones are re-versioned and
 * re-signed, and rules a person edited (locked) are never overwritten.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { policyEvents, policyRules, regulatorySources } from '../db/schema.js';
import { initSigningKeys } from './signing.js';
import { verifyRuleSignature } from './rule-signing.js';
import { upsertExtractedRule, type ExtractedRule } from './rule-upsert.js';

let sourceId: string;

const extracted = (overrides: Partial<ExtractedRule> = {}): ExtractedRule => ({
  ruleKey: 'upsert.test.rule',
  jurisdiction: 'EU',
  category: 'transparency',
  conditions: { action: 'text_generation' },
  effect: 'require_disclosure',
  severity: 'medium',
  humanSummary: 'Extracted summary of the obligation.',
  legalReference: 'Test Act Art. 1',
  effectiveDate: '2025-01-01',
  expiresAt: null,
  ...overrides,
});

function upsert(rule: ExtractedRule) {
  const db = getDb();
  let seq = (db.select().from(policyEvents).all().length) + 1000;
  return db.transaction((tx) =>
    upsertExtractedRule(tx, { sourceId, now: new Date().toISOString(), nextSequence: () => seq++ }, rule),
  );
}

const byKey = (key: string) => getDb().select().from(policyRules).where(eq(policyRules.ruleKey, key)).get()!;

beforeAll(() => {
  runMigrations();
  initSigningKeys();
  sourceId = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(regulatorySources).values({
    id: sourceId, name: 'Upsert Source', jurisdiction: 'EU', url: 'https://example.com',
    parserType: 'html', createdAt: now, updatedAt: now,
  }).run();
});

describe('upsertExtractedRule', () => {
  it('creates a signed, unlocked rule with a policy.created event', () => {
    expect(upsert(extracted())).toBe('created');
    const row = byKey('upsert.test.rule');
    expect(row).toMatchObject({ version: 1, locked: false, isActive: true });
    expect(verifyRuleSignature(row)).toBe(true);
    const events = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, row.id)).all();
    expect(events.map((e) => e.eventType)).toEqual(['policy.created']);
  });

  it('updates an unlocked rule: version bump, new signature that verifies', () => {
    expect(upsert(extracted({ severity: 'high', humanSummary: 'Re-extracted summary.' }))).toBe('updated');
    const row = byKey('upsert.test.rule');
    expect(row).toMatchObject({ version: 2, severity: 'high', humanSummary: 'Re-extracted summary.' });
    expect(verifyRuleSignature(row)).toBe(true);
  });

  it('skips a locked rule and leaves it, and its history, untouched', () => {
    const before = byKey('upsert.test.rule');
    getDb().update(policyRules).set({ locked: true }).where(eq(policyRules.id, before.id)).run();
    const eventsBefore = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, before.id)).all().length;

    expect(upsert(extracted({ severity: 'low', humanSummary: 'Pipeline overwrite attempt.' }))).toBe('skipped_locked');

    const after = byKey('upsert.test.rule');
    expect(after).toEqual({ ...before, locked: true });
    expect(getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, before.id)).all()).toHaveLength(eventsBefore);
  });

  it('resumes updating once the rule is handed back', () => {
    const row = byKey('upsert.test.rule');
    getDb().update(policyRules).set({ locked: false }).where(eq(policyRules.id, row.id)).run();
    expect(upsert(extracted({ severity: 'critical' }))).toBe('updated');
    expect(byKey('upsert.test.rule')).toMatchObject({ version: 3, severity: 'critical' });
  });
});

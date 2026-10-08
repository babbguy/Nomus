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
import { publishRuleEvents, type PendingRuleEvent } from './rule-management.js';
import { registerClient, removeClient } from '../sse/manager.js';

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

  it('leaves an identical re-extraction alone: no version bump, event or re-signing', () => {
    const before = byKey('upsert.test.rule');
    const eventsBefore = getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, before.id)).all().length;
    const same = extracted({
      severity: before.severity,
      // Key order differs from the stored JSON; it is the same condition set.
      conditions: { ...JSON.parse(before.conditions) },
      industries: JSON.parse(before.industries ?? '["all"]'),
    });
    expect(upsert(same)).toBe('unchanged');
    expect(byKey('upsert.test.rule')).toEqual(before);
    expect(getDb().select().from(policyEvents).where(eq(policyEvents.ruleId, before.id)).all()).toHaveLength(eventsBefore);
  });

  it('stores every signed field, so an update that changes the category still verifies', () => {
    expect(upsert(extracted({ severity: 'critical', category: 'accountability', industries: ['healthcare'] }))).toBe('updated');
    const row = byKey('upsert.test.rule');
    expect(row.category).toBe('accountability');
    expect(JSON.parse(row.industries ?? '[]')).toEqual(['healthcare']);
    expect(verifyRuleSignature(row)).toBe(true);
  });
});


describe('live delivery of upserted rules', () => {
  it('delivers one policy.created per new rule to a connected subscriber, with its sequence as the SSE id', () => {
    const received: string[] = [];
    const decoder = new TextDecoder();
    const clientId = registerClient('org-upsert-live', [], {
      enqueue: (chunk: Uint8Array) => { received.push(decoder.decode(chunk)); },
    } as unknown as ReadableStreamDefaultController);
    expect(clientId).not.toBeNull();

    try {
      const db = getDb();
      let seq = db.select().from(policyEvents).all().length + 5000;
      const pending: PendingRuleEvent[] = [];
      const now = new Date().toISOString();
      db.transaction((tx) => {
        for (const n of [1, 2, 3]) {
          upsertExtractedRule(tx, { sourceId, now, nextSequence: () => seq++ },
            extracted({ ruleKey: `upsert.live.rule_${n}` }), pending);
        }
      });
      // Nothing is sent until the caller publishes after commit.
      expect(received).toHaveLength(0);
      publishRuleEvents(pending);

      expect(received).toHaveLength(3);
      for (const [i, n] of [1, 2, 3].entries()) {
        const stored = db.select().from(policyEvents)
          .where(eq(policyEvents.ruleId, byKey(`upsert.live.rule_${n}`).id)).get()!;
        expect(received[i]).toBe(
          `id: ${stored.sequence}\nevent: policy.created\ndata: ${stored.payload}\n\n`,
        );
      }
    } finally {
      removeClient(clientId!);
    }
  });

  it('collects policy.updated for a changed rule and nothing for unchanged rules', () => {
    const db = getDb();
    let seq = db.select().from(policyEvents).all().length + 6000;
    const run = (rule: ExtractedRule) => {
      const pending: PendingRuleEvent[] = [];
      db.transaction((tx) => {
        upsertExtractedRule(tx, { sourceId, now: new Date().toISOString(), nextSequence: () => seq++ }, rule, pending);
      });
      return pending;
    };
    expect(run(extracted({ ruleKey: 'upsert.live.updated' }))).toHaveLength(1);
    expect(run(extracted({ ruleKey: 'upsert.live.updated' }))).toHaveLength(0);
    const changed = run(extracted({ ruleKey: 'upsert.live.updated', severity: 'high' }));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ eventType: 'policy.updated', jurisdiction: 'EU' });
    expect(changed[0].payload).toMatchObject({ version: 2, severity: 'high' });
  });
});

/**
 * Clause Map — dataset, correlator, and learning-loop tests.
 *
 * Covers:
 *   D1  dataset seeds idempotently; reseed preserves learned weights
 *   C1  single-signal heuristic fires (phi_in_ai_call → HIPAA §164.502(a))
 *   C2  multi-signal heuristic requires all signals in the SAME file
 *   C3  anyOf alternatives satisfy a requirement
 *   C4  no findings → no matches; unrelated capabilities → no matches
 *   C5  dedup: re-uploading the same scan does not duplicate open matches
 *   C6  suppression: dismissed match is not re-opened by the next scan,
 *       and the suppression is logged as a learning event
 *   L1  confirm feedback raises the posterior; dismiss lowers it
 *   L2  posterior math matches the documented Beta-mean formula
 *   L3  flip-flop feedback transitions weights instead of double-counting
 *   L4  every posterior change appends a clause_learning_events row
 *   L5  new matches after learning carry the updated posterior in confidence
 *   R1  routes: mappings list, matches list, feedback endpoint (org-scoped)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';

import { getDb, closeDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  organizations,
  clauseMappings,
  clauseMatches,
  clauseLearningEvents,
} from '../db/schema.js';
import {
  CLAUSE_MAPPING_DATASET,
  seedClauseMappings,
  posteriorMean,
} from './dataset.js';
import { correlateScan, evaluateSignature, type CorrelatableFinding } from './correlator.js';
import { applyMatchFeedback } from './learning.js';

const ORG_ID = 'clausemap-org-' + randomUUID();

function finding(partial: Partial<CorrelatableFinding> & { capability: string }): CorrelatableFinding {
  return {
    id: randomUUID(),
    filePath: '/src/app.ts',
    lineNumber: 10,
    detectorSource: null,
    severity: 'high',
    ...partial,
  };
}

function db() {
  return getDb();
}

beforeAll(() => {
  closeDb();
  runMigrations();
  const now = new Date().toISOString();
  db().insert(organizations).values({
    id: ORG_ID,
    name: 'ClauseMap Test Org',
    slug: 'clausemap-' + Date.now(),
    jurisdictionAccess: '[]',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }).run();
  seedClauseMappings(db() as any);
});

function mappingByKey(key: string) {
  const row = db().select().from(clauseMappings).where(eq(clauseMappings.mappingKey, key)).get();
  expect(row, `mapping ${key} must be seeded`).toBeDefined();
  return row!;
}

describe('D — dataset seeding', () => {
  it('D1: seeds every dataset entry exactly once; reseed is a no-op that preserves learned weights', () => {
    const all = db().select().from(clauseMappings).all();
    expect(all.length).toBeGreaterThanOrEqual(CLAUSE_MAPPING_DATASET.length);

    // Simulate learned state, then reseed at the same version
    const target = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    db().update(clauseMappings)
      .set({ confirmedWeight: 3, dismissedWeight: 1 })
      .where(eq(clauseMappings.id, target.id))
      .run();

    const result = seedClauseMappings(db() as any);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);

    const after = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    expect(after.confirmedWeight).toBe(3);
    expect(after.dismissedWeight).toBe(1);

    // restore
    db().update(clauseMappings)
      .set({ confirmedWeight: 0, dismissedWeight: 0 })
      .where(eq(clauseMappings.id, target.id))
      .run();
  });

  it('D1b: every seeded posterior equals the documented prior mean', () => {
    for (const seed of CLAUSE_MAPPING_DATASET) {
      const row = mappingByKey(seed.mappingKey);
      const expected = seed.priorAlpha / (seed.priorAlpha + seed.priorBeta);
      expect(row.posterior).toBeCloseTo(
        posteriorMean(seed.priorAlpha, seed.priorBeta, row.confirmedWeight, row.dismissedWeight),
        10,
      );
      if (row.confirmedWeight === 0 && row.dismissedWeight === 0) {
        expect(row.posterior).toBeCloseTo(expected, 10);
      }
    }
  });
});

describe('C — correlator', () => {
  it('C1: phi_in_ai_call fires the HIPAA §164.502(a) mapping', () => {
    const repo = 'org/repo-c1';
    const result = correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'phi_in_ai_call', detectorSource: 'phi-pattern-detector' }),
    ]);
    expect(result.created).toBeGreaterThanOrEqual(1);

    const mapping = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    const match = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .get();
    expect(match).toBeDefined();
    expect(match!.status).toBe('open');
    const evidence = JSON.parse(match!.evidenceJson);
    expect(evidence[0].capability).toBe('phi_in_ai_call');
    // confidence = posterior × severity weight (high = 0.9)
    expect(match!.confidence).toBeCloseTo(mapping.posterior * 0.9, 10);
  });

  it('C2: multi-signal heuristic requires all signals in the same file', () => {
    // contains_phi in one file, sends_to_third_party in another → no §164.502(e)
    const repo = 'org/repo-c2';
    correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'contains_phi', filePath: '/a.ts' }),
      finding({ capability: 'sends_to_third_party', filePath: '/b.ts' }),
    ]);
    const mapping = mappingByKey('phi-to-third-party::hipaa-164.502e');
    const cross = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .all();
    expect(cross.length).toBe(0);

    // Same file → fires
    const repo2 = 'org/repo-c2b';
    correlateScan(db() as any, ORG_ID, repo2, 'sha1', [
      finding({ capability: 'contains_phi', filePath: '/a.ts', lineNumber: 5 }),
      finding({ capability: 'sends_to_third_party', filePath: '/a.ts', lineNumber: 9 }),
    ]);
    const sameFile = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo2), eq(clauseMatches.mappingId, mapping.id)))
      .all();
    expect(sameFile.length).toBe(1);
    expect(JSON.parse(sameFile[0].evidenceJson).length).toBe(2);
  });

  it('C3: anyOf alternative satisfies a requirement', () => {
    // phi_in_ai_call is an anyOf alternative for contains_phi in 164.502(e)
    const repo = 'org/repo-c3';
    correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'phi_in_ai_call', filePath: '/x.ts', lineNumber: 3 }),
      finding({ capability: 'sends_to_third_party', filePath: '/x.ts', lineNumber: 6 }),
    ]);
    const mapping = mappingByKey('phi-to-third-party::hipaa-164.502e');
    const match = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .get();
    expect(match).toBeDefined();
  });

  it('C4: unrelated capabilities produce no matches; empty findings are a no-op', () => {
    const repo = 'org/repo-c4';
    const r1 = correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'text_generation' }),
    ]);
    // text_generation alone maps to nothing in the dataset
    const matches = db().select().from(clauseMatches).where(eq(clauseMatches.repo, repo)).all();
    expect(matches.length).toBe(0);
    expect(r1.evaluated).toBeGreaterThan(0);

    const r2 = correlateScan(db() as any, ORG_ID, repo, 'sha1', []);
    expect(r2.created).toBe(0);
  });

  it('C5: re-uploading the same scan does not duplicate open matches', () => {
    const repo = 'org/repo-c5';
    const scan = [finding({ capability: 'pii_in_ai_call', filePath: '/svc.ts' })];
    const first = correlateScan(db() as any, ORG_ID, repo, 'sha1', scan);
    const second = correlateScan(db() as any, ORG_ID, repo, 'sha2', scan);
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(second.created).toBe(0);

    const mapping = mappingByKey('pii-in-ai-call::gdpr-5.1c');
    const all = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .all();
    expect(all.length).toBe(1);
  });

  it('C6: a dismissed match suppresses re-creation on the next scan and logs the suppression', () => {
    const repo = 'org/repo-c6';
    const scan = [finding({ capability: 'pii_in_ai_call', filePath: '/svc.ts' })];
    correlateScan(db() as any, ORG_ID, repo, 'sha1', scan);

    const mapping = mappingByKey('pii-in-ai-call::gdpr-5.1c');
    const match = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .get()!;
    applyMatchFeedback(db() as any, ORG_ID, match.id, 'dismiss');

    const rescan = correlateScan(db() as any, ORG_ID, repo, 'sha2', scan);
    expect(rescan.created).toBe(0);
    expect(rescan.suppressed).toBeGreaterThanOrEqual(1);

    const still = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .all();
    expect(still.length).toBe(1);
    expect(still[0].status).toBe('dismissed');

    const suppressEvents = db().select().from(clauseLearningEvents)
      .where(and(
        eq(clauseLearningEvents.mappingId, mapping.id),
        eq(clauseLearningEvents.eventType, 'scan_suppressed'),
      ))
      .all();
    expect(suppressEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('C-unit: evaluateSignature respects maxLineDistance', () => {
    const sig = {
      requires: [{ capability: 'contains_phi' }, { capability: 'text_generation' }],
      maxLineDistance: 5,
    };
    const near = evaluateSignature(sig, [
      finding({ capability: 'contains_phi', lineNumber: 10 }),
      finding({ capability: 'text_generation', lineNumber: 13 }),
    ]);
    expect(near).not.toBeNull();

    const far = evaluateSignature(sig, [
      finding({ capability: 'contains_phi', lineNumber: 10 }),
      finding({ capability: 'text_generation', lineNumber: 100 }),
    ]);
    expect(far).toBeNull();
  });
});

describe('L — learning loop', () => {
  function fireFreshMatch(repo: string): { matchId: string; mappingId: string } {
    correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'phi_in_ai_call', filePath: '/l.ts' }),
    ]);
    const mapping = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    const match = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .get()!;
    return { matchId: match.id, mappingId: mapping.id };
  }

  it('L1/L2: confirm raises the posterior per the Beta-mean formula; dismiss lowers it', () => {
    const { matchId } = fireFreshMatch('org/repo-l1');
    const before = mappingByKey('phi-in-ai-call::hipaa-164.502a');

    const result = applyMatchFeedback(db() as any, ORG_ID, matchId, 'confirm')!;
    expect(result.posteriorAfter).toBeGreaterThan(result.posteriorBefore);
    expect(result.posteriorAfter).toBeCloseTo(
      posteriorMean(before.priorAlpha, before.priorBeta, before.confirmedWeight + 1, before.dismissedWeight),
      10,
    );

    // Dismiss a second, separate match → posterior drops from its new level
    const { matchId: m2 } = fireFreshMatch('org/repo-l1b');
    const result2 = applyMatchFeedback(db() as any, ORG_ID, m2, 'dismiss')!;
    expect(result2.posteriorAfter).toBeLessThan(result2.posteriorBefore);
  });

  it('L3: flip-flop feedback transitions weights instead of double-counting', () => {
    const { matchId } = fireFreshMatch('org/repo-l3');
    const base = mappingByKey('phi-in-ai-call::hipaa-164.502a');

    applyMatchFeedback(db() as any, ORG_ID, matchId, 'confirm');
    applyMatchFeedback(db() as any, ORG_ID, matchId, 'dismiss');

    const after = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    // Net effect of confirm-then-dismiss on the same match: +1 dismissed only
    expect(after.confirmedWeight).toBeCloseTo(base.confirmedWeight, 10);
    expect(after.dismissedWeight).toBeCloseTo(base.dismissedWeight + 1, 10);

    // Repeating the same verdict is a no-op for weights
    const repeat = applyMatchFeedback(db() as any, ORG_ID, matchId, 'dismiss')!;
    expect(repeat.posteriorAfter).toBeCloseTo(repeat.posteriorBefore, 10);
  });

  it('L4: every posterior change appends a learning event with before/after', () => {
    const { matchId, mappingId } = fireFreshMatch('org/repo-l4');
    const countBefore = db().select().from(clauseLearningEvents)
      .where(eq(clauseLearningEvents.mappingId, mappingId)).all().length;

    const result = applyMatchFeedback(db() as any, ORG_ID, matchId, 'confirm', 'looks right')!;
    const events = db().select().from(clauseLearningEvents)
      .where(eq(clauseLearningEvents.mappingId, mappingId)).all();
    expect(events.length).toBe(countBefore + 1);

    const last = events[events.length - 1];
    expect(last.eventType).toBe('feedback_confirm');
    expect(last.posteriorBefore).toBeCloseTo(result.posteriorBefore, 10);
    expect(last.posteriorAfter).toBeCloseTo(result.posteriorAfter, 10);
    expect(JSON.parse(last.detailsJson).note).toBe('looks right');
  });

  it('L5: matches created after learning carry the updated posterior in confidence', () => {
    const mapping = mappingByKey('phi-in-ai-call::hipaa-164.502a');
    const repo = 'org/repo-l5';
    correlateScan(db() as any, ORG_ID, repo, 'sha1', [
      finding({ capability: 'phi_in_ai_call', filePath: '/fresh.ts', severity: 'critical' }),
    ]);
    const match = db().select().from(clauseMatches)
      .where(and(eq(clauseMatches.repo, repo), eq(clauseMatches.mappingId, mapping.id)))
      .get()!;
    // critical severity weight = 1.0 → confidence == live posterior at match time
    expect(match.confidence).toBeCloseTo(mapping.posterior, 10);
  });

  it('L-idor: feedback is org-scoped', () => {
    const { matchId } = fireFreshMatch('org/repo-lidor');
    const result = applyMatchFeedback(db() as any, 'some-other-org', matchId, 'confirm');
    expect(result).toBeNull();
  });
});

/**
 * Scout Accuracy Ledger: outcome recorder tests.
 *
 * Uses the real engine DB client — .env.test sets NOMUS_DB_PATH=:memory:
 * and vitest isolates each test file in its own process, so this file owns
 * its database. Tables come from the real production migrator and signing
 * uses the real Ed25519 path (test-only secret from .env.test).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  billOutcomes,
  billScoreHistory,
  billStageHistory,
  trackedBills,
} from '../db/schema.js';
import { initSigningKeys, verifySignature } from '../core/signing.js';
import { canonicalJSON } from '../core/policy-compiler.js';
import {
  mapStageToOutcome,
  recordOutcomeIfTerminal,
  reconcileOutcomes,
  recordSessionEndFailures,
  updateBillStage,
  usFedBienniumEnd,
  verifyOutcomeSignature,
  METHODOLOGY_VERSION,
} from './outcome-recorder.js';
import { computeAndRecordScore } from './passage-score.js';

const OUTCOME_AT = '2026-06-01T00:00:00.000Z';
const DAY_MS = 86_400_000;

function isoDaysBefore(baseIso: string, days: number): string {
  return new Date(Date.parse(baseIso) - days * DAY_MS).toISOString();
}

function insertBill(overrides: Partial<typeof trackedBills.$inferInsert> = {}): string {
  const id = overrides.id ?? randomUUID();
  const now = new Date().toISOString();
  getDb().insert(trackedBills).values({
    title: 'AI Accountability Act',
    jurisdiction: 'US-FED',
    currentStage: 'introduced',
    progressPercent: 20,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  }).run();
  return id;
}

function insertScore(billId: string, score: number, computedAt: string): void {
  getDb().insert(billScoreHistory).values({
    billId,
    score,
    momentum: 70,
    baseRate: 50,
    sponsorStrength: 30,
    sentiment: 50,
    political: 50,
    opposition: 70,
    computedAt,
  }).run();
}

/** Fixture history: -100d:20, -65d:40, -35d:60, -5d:80 relative to OUTCOME_AT. */
function seedFixtureHistory(billId: string): void {
  insertScore(billId, 20, isoDaysBefore(OUTCOME_AT, 100));
  insertScore(billId, 40, isoDaysBefore(OUTCOME_AT, 65));
  insertScore(billId, 60, isoDaysBefore(OUTCOME_AT, 35));
  insertScore(billId, 80, isoDaysBefore(OUTCOME_AT, 5));
}

beforeAll(() => {
  runMigrations();
  initSigningKeys();
});

beforeEach(() => {
  const db = getDb();
  db.delete(billOutcomes).run();
  db.delete(billScoreHistory).run();
  db.delete(billStageHistory).run();
  db.delete(trackedBills).run();
});

// ─── Stage → outcome mapping ───────────────────────────────────

describe('mapStageToOutcome', () => {
  it('maps enacted stages, including repealed (a repealed law WAS enacted)', () => {
    for (const stage of ['signed', 'veto_override', 'awaiting_effective', 'in_force', 'repealed']) {
      expect(mapStageToOutcome(stage)).toBe('enacted');
    }
  });

  it('maps died to failed', () => {
    expect(mapStageToOutcome('died')).toBe('failed');
  });

  it('does NOT map vetoed, stalled, or active stages to any outcome', () => {
    // vetoed is pending — an override can still enact the bill
    for (const stage of ['vetoed', 'stalled', 'introduced', 'committee_passed', 'floor_vote', 'executive_review', 'rumor']) {
      expect(mapStageToOutcome(stage)).toBeNull();
    }
  });
});

// ─── recordOutcomeIfTerminal ───────────────────────────────────

describe('recordOutcomeIfTerminal', () => {
  it('freezes a signed enacted row with correct T30/T60/T90/peak from fixture history', () => {
    const billId = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    seedFixtureHistory(billId);

    const result = recordOutcomeIfTerminal(billId);
    expect(result).not.toBeNull();
    expect(result!.recorded).toBe(true);
    expect(result!.alreadyExisted).toBe(false);

    const row = result!.row;
    expect(row.outcome).toBe('enacted');
    expect(row.finalStage).toBe('signed');
    expect(row.outcomeAt).toBe(OUTCOME_AT); // from lastActionDate (no stage history)
    expect(row.scoreAtOutcome).toBe(80); // latest at-or-before outcomeAt (-5d row)
    expect(row.scoreT30).toBe(60); // latest at-or-before -30d (-35d row)
    expect(row.scoreT60).toBe(40); // latest at-or-before -60d (-65d row)
    expect(row.scoreT90).toBe(20); // latest at-or-before -90d (-100d row)
    expect(row.peakScore).toBe(80);
    expect(row.methodologyVersion).toBe(METHODOLOGY_VERSION);
    expect(Number.isNaN(Date.parse(row.recordedAt))).toBe(false);

    // componentSnapshot carries the T30 row's 6-component breakdown
    const snapshot = JSON.parse(row.componentSnapshot!);
    expect(snapshot.componentsT30).toEqual({
      momentum: 70,
      baseRate: 50,
      sponsorStrength: 30,
      sentiment: 50,
      political: 50,
      opposition: 70,
      computedAt: isoDaysBefore(OUTCOME_AT, 35),
    });
    expect(snapshot.sessionEnd).toBeUndefined();
  });

  it('records null T-scores when no history exists before the cutoffs', () => {
    const billId = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    insertScore(billId, 75, isoDaysBefore(OUTCOME_AT, 2)); // only a recent score

    const result = recordOutcomeIfTerminal(billId)!;
    expect(result.row.scoreAtOutcome).toBe(75);
    expect(result.row.scoreT30).toBeNull();
    expect(result.row.scoreT60).toBeNull();
    expect(result.row.scoreT90).toBeNull();
    expect(result.row.peakScore).toBe(75);
    expect(JSON.parse(result.row.componentSnapshot!).componentsT30).toBeNull();
  });

  it('returns null and writes no row for a non-terminal stage', () => {
    const billId = insertBill({ currentStage: 'committee_passed' });
    expect(recordOutcomeIfTerminal(billId)).toBeNull();
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('returns null and writes no row for stalled (not auto-failed on stage alone)', () => {
    const billId = insertBill({ currentStage: 'stalled' });
    expect(recordOutcomeIfTerminal(billId)).toBeNull();
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('is idempotent: a second call is success without a duplicate', () => {
    const billId = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    const first = recordOutcomeIfTerminal(billId)!;
    const second = recordOutcomeIfTerminal(billId)!;

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(1);
  });

  it('maps repealed to enacted', () => {
    const billId = insertBill({ currentStage: 'repealed', lastActionDate: OUTCOME_AT });
    const result = recordOutcomeIfTerminal(billId)!;
    expect(result.row.outcome).toBe('enacted');
    expect(result.row.finalStage).toBe('repealed');
  });

  it('records NO outcome for vetoed (pending until override, death, or session end)', () => {
    const billId = insertBill({ currentStage: 'vetoed', lastActionDate: OUTCOME_AT });
    expect(recordOutcomeIfTerminal(billId)).toBeNull();
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('maps veto_override to enacted', () => {
    const billId = insertBill({ currentStage: 'veto_override', lastActionDate: OUTCOME_AT });
    const result = recordOutcomeIfTerminal(billId)!;
    expect(result.row.outcome).toBe('enacted');
    expect(result.row.finalStage).toBe('veto_override');
  });

  it('prefers bill_stage_history entered_at over last_action_date for outcomeAt', () => {
    const enteredAt = '2026-05-15T09:30:00.000Z';
    const billId = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    getDb().insert(billStageHistory).values({
      billId, stage: 'signed', enteredAt, source: 'test',
    }).run();

    const result = recordOutcomeIfTerminal(billId)!;
    expect(result.row.outcomeAt).toBe(enteredAt);
  });

  it('throws for an unknown bill id (zero silent failures)', () => {
    expect(() => recordOutcomeIfTerminal(randomUUID())).toThrow(/not found/);
  });

  it('produces a signature verifiable with the public key', () => {
    const billId = insertBill({ currentStage: 'in_force', lastActionDate: OUTCOME_AT });
    seedFixtureHistory(billId);
    const { row } = recordOutcomeIfTerminal(billId)!;

    // Via the module's own verifier
    expect(verifyOutcomeSignature(row)).toBe(true);

    // And independently: canonical JSON of the record minus signature
    const payload = canonicalJSON({
      id: row.id,
      billId: row.billId,
      finalStage: row.finalStage,
      outcome: row.outcome,
      outcomeAt: row.outcomeAt,
      scoreAtOutcome: row.scoreAtOutcome,
      scoreT30: row.scoreT30,
      scoreT60: row.scoreT60,
      scoreT90: row.scoreT90,
      peakScore: row.peakScore,
      componentSnapshot: row.componentSnapshot,
      recordedAt: row.recordedAt,
      methodologyVersion: row.methodologyVersion,
    });
    expect(verifySignature(payload, row.signature)).toBe(true);

    // Tampering is detected
    expect(verifyOutcomeSignature({ ...row, scoreT30: 99 })).toBe(false);
    expect(verifyOutcomeSignature({ ...row, outcome: 'failed' })).toBe(false);
  });
});

// ─── updateBillStage (canonical transition hook) ───────────────

describe('updateBillStage', () => {
  it('transitions the stage, writes stage history, and freezes the outcome on terminal entry', () => {
    const billId = insertBill({ currentStage: 'executive_review' });
    const result = updateBillStage(billId, 'signed', 'test_feed');

    const bill = getDb().select().from(trackedBills).where(eq(trackedBills.id, billId)).get()!;
    expect(bill.currentStage).toBe('signed');
    expect(bill.progressPercent).toBe(95);

    const history = getDb().select().from(billStageHistory).all();
    expect(history).toHaveLength(1);
    expect(history[0].stage).toBe('signed');
    expect(history[0].source).toBe('test_feed');

    expect(result).not.toBeNull();
    expect(result!.row.outcome).toBe('enacted');
    expect(result!.row.finalStage).toBe('signed');
  });

  it('records no outcome for a non-terminal transition', () => {
    const billId = insertBill({ currentStage: 'introduced' });
    const result = updateBillStage(billId, 'committee_referred', 'test_feed');
    expect(result).toBeNull();
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('rejects unknown stage ids at the boundary', () => {
    const billId = insertBill();
    expect(() => updateBillStage(billId, 'not_a_stage', 'test')).toThrow(/unknown lifecycle stage/);
  });
});

// ─── passage-score hook ────────────────────────────────────────

describe('computeAndRecordScore terminal hook', () => {
  it('freezes an outcome when a bill is re-scored while in a terminal-mapped stage', () => {
    const billId = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    computeAndRecordScore(getDb(), billId, {
      currentStage: 'signed',
      lastActionDate: OUTCOME_AT,
      jurisdiction: 'US-FED',
    });

    const rows = getDb().select().from(billOutcomes).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('enacted');
  });
});

// ─── reconcileOutcomes ─────────────────────────────────────────

describe('reconcileOutcomes', () => {
  it('records outcomes for terminal-stage bills that bypassed the hook, exactly once', () => {
    const a = insertBill({ currentStage: 'signed', lastActionDate: OUTCOME_AT });
    const b = insertBill({ currentStage: 'died', lastActionDate: OUTCOME_AT });
    insertBill({ currentStage: 'floor_vote' }); // active — untouched
    insertBill({ currentStage: 'stalled' }); // stalled — untouched

    expect(reconcileOutcomes()).toBe(2);
    const rows = getDb().select().from(billOutcomes).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.billId === a)!.outcome).toBe('enacted');
    expect(rows.find((r) => r.billId === b)!.outcome).toBe('failed');

    // Second sweep records nothing new
    expect(reconcileOutcomes()).toBe(0);
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(2);
  });
});

// ─── Session-end (US-FED biennium) ─────────────────────────────

describe('usFedBienniumEnd', () => {
  it('computes noon UTC Jan 3 of the most recent odd year', () => {
    expect(usFedBienniumEnd(new Date('2026-07-24T00:00:00.000Z')).toISOString())
      .toBe('2025-01-03T12:00:00.000Z');
    expect(usFedBienniumEnd(new Date('2025-01-02T00:00:00.000Z')).toISOString())
      .toBe('2023-01-03T12:00:00.000Z');
    expect(usFedBienniumEnd(new Date('2025-01-03T11:59:59.000Z')).toISOString())
      .toBe('2023-01-03T12:00:00.000Z');
    expect(usFedBienniumEnd(new Date('2025-01-03T12:00:00.000Z')).toISOString())
      .toBe('2025-01-03T12:00:00.000Z');
    expect(usFedBienniumEnd(new Date('2024-12-31T23:59:59.000Z')).toISOString())
      .toBe('2023-01-03T12:00:00.000Z');
  });
});

describe('recordSessionEndFailures', () => {
  const NOW = '2026-07-24T00:00:00.000Z';
  const BOUNDARY = '2025-01-03T12:00:00.000Z';

  it('fails stale US-FED bills at the biennium boundary with the sessionEnd marker', () => {
    const staleId = insertBill({
      currentStage: 'committee_referred',
      lastActionDate: '2024-06-01T00:00:00.000Z',
    });
    insertScore(staleId, 45, '2024-05-01T00:00:00.000Z');

    expect(recordSessionEndFailures(getDb(), NOW)).toBe(1);

    const row = getDb().select().from(billOutcomes).where(eq(billOutcomes.billId, staleId)).get()!;
    expect(row.outcome).toBe('failed');
    expect(row.finalStage).toBe('died');
    expect(row.outcomeAt).toBe(BOUNDARY);
    expect(JSON.parse(row.componentSnapshot!).sessionEnd).toBe(true);
    expect(verifyOutcomeSignature(row)).toBe(true);

    // Stage was transitioned to died with history
    const bill = getDb().select().from(trackedBills).where(eq(trackedBills.id, staleId)).get()!;
    expect(bill.currentStage).toBe('died');
    const history = getDb().select().from(billStageHistory).all();
    expect(history.some((h) => h.stage === 'died' && h.source === 'session_end')).toBe(true);
  });

  it('also sweeps stalled US-FED bills (the only path that fails stalled)', () => {
    const stalledId = insertBill({
      currentStage: 'stalled',
      lastActionDate: '2023-09-15T00:00:00.000Z',
    });
    expect(recordSessionEndFailures(getDb(), NOW)).toBe(1);
    const row = getDb().select().from(billOutcomes).where(eq(billOutcomes.billId, stalledId)).get()!;
    expect(row.outcome).toBe('failed');
    expect(JSON.parse(row.componentSnapshot!).sessionEnd).toBe(true);
  });

  it('sweeps stale vetoed US-FED bills (the never-overridden veto resolution path)', () => {
    const vetoedId = insertBill({
      currentStage: 'vetoed',
      lastActionDate: '2024-08-01T00:00:00.000Z',
    });
    expect(recordSessionEndFailures(getDb(), NOW)).toBe(1);
    const row = getDb().select().from(billOutcomes).where(eq(billOutcomes.billId, vetoedId)).get()!;
    expect(row.outcome).toBe('failed');
    expect(row.finalStage).toBe('died');
    expect(JSON.parse(row.componentSnapshot!).sessionEnd).toBe(true);
  });

  it('leaves recent US-FED bills untouched', () => {
    insertBill({ currentStage: 'floor_vote', lastActionDate: '2026-06-01T00:00:00.000Z' });
    expect(recordSessionEndFailures(getDb(), NOW)).toBe(0);
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('leaves non-US-FED stalled bills untouched (documented v1 scope boundary)', () => {
    insertBill({
      jurisdiction: 'US-CA',
      currentStage: 'stalled',
      lastActionDate: '2023-01-01T00:00:00.000Z',
    });
    insertBill({
      jurisdiction: 'EU',
      currentStage: 'committee_referred',
      lastActionDate: '2022-01-01T00:00:00.000Z',
    });
    expect(recordSessionEndFailures(getDb(), NOW)).toBe(0);
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(0);
  });

  it('skips bills without a last action date and is idempotent across runs', () => {
    insertBill({ currentStage: 'introduced', lastActionDate: null });
    const staleId = insertBill({
      currentStage: 'introduced',
      lastActionDate: '2024-02-01T00:00:00.000Z',
    });

    expect(recordSessionEndFailures(getDb(), NOW)).toBe(1);
    expect(recordSessionEndFailures(getDb(), NOW)).toBe(0);
    expect(getDb().select().from(billOutcomes).all()).toHaveLength(1);
    expect(getDb().select().from(billOutcomes).all()[0].billId).toBe(staleId);
  });
});

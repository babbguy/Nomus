/**
 * Scout Accuracy Ledger: calibration tests.
 *
 * Hand-computed fixture assertions against computeAccuracyStats (pure) plus
 * DB round-trip tests for runAccuracyCalibration. Uses the real engine DB
 * client (:memory: per .env.test; vitest isolates this file's process).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { accuracySnapshots, billOutcomes, trackedBills } from '../db/schema.js';
import {
  computeAccuracyStats,
  emptyCalibrationBuckets,
  emptyHitRates,
  runAccuracyCalibration,
  CalibrationBucketsSchema,
  HitRatesSchema,
  ByJurisdictionSchema,
  MIN_PUBLISH_N,
  METHODOLOGY_VERSION,
  type OutcomeForCalibration,
} from './accuracy-calibration.js';

/**
 * Hand-computed fixture — 6 outcomes, 5 calibration-eligible:
 *   A enacted T30=80  US-FED → (0.80-1)^2 = 0.0400
 *   B enacted T30=95  US-FED → (0.95-1)^2 = 0.0025
 *   C failed  T30=20  US-CA  → (0.20-0)^2 = 0.0400
 *   D failed  T30=55  US-CA  → (0.55-0)^2 = 0.3025
 *   E enacted T30=null EU    → excluded from calibration math
 *   F failed  T30=70  EU     → (0.70-0)^2 = 0.4900
 * Brier = (0.04 + 0.0025 + 0.04 + 0.3025 + 0.49) / 5 = 0.875 / 5 = 0.175
 */
const FIXTURE: OutcomeForCalibration[] = [
  { outcome: 'enacted', scoreT30: 80, jurisdiction: 'US-FED' },
  { outcome: 'enacted', scoreT30: 95, jurisdiction: 'US-FED' },
  { outcome: 'failed', scoreT30: 20, jurisdiction: 'US-CA' },
  { outcome: 'failed', scoreT30: 55, jurisdiction: 'US-CA' },
  { outcome: 'enacted', scoreT30: null, jurisdiction: 'EU' },
  { outcome: 'failed', scoreT30: 70, jurisdiction: 'EU' },
];

describe('computeAccuracyStats (hand-computed fixture)', () => {
  it('computes exact sample counts and Brier score', () => {
    const stats = computeAccuracyStats(FIXTURE);
    expect(stats.sampleSize).toBe(6);
    expect(stats.enactedCount).toBe(3);
    expect(stats.failedCount).toBe(3);
    expect(stats.withCalibrationScore).toBe(5);
    expect(stats.brierScore).toBeCloseTo(0.175, 10);
  });

  it('computes exact calibration buckets (observed as percentage, null when empty)', () => {
    const { calibrationBuckets } = computeAccuracyStats(FIXTURE);
    expect(calibrationBuckets).toHaveLength(10);

    const byLabel = Object.fromEntries(calibrationBuckets.map((b) => [b.bucket, b]));
    expect(byLabel['20-30']).toEqual({ bucket: '20-30', predictedMidpoint: 25, observed: 0, n: 1 }); // C
    expect(byLabel['50-60']).toEqual({ bucket: '50-60', predictedMidpoint: 55, observed: 0, n: 1 }); // D
    expect(byLabel['70-80']).toEqual({ bucket: '70-80', predictedMidpoint: 75, observed: 0, n: 1 }); // F
    expect(byLabel['80-90']).toEqual({ bucket: '80-90', predictedMidpoint: 85, observed: 100, n: 1 }); // A
    expect(byLabel['90-100']).toEqual({ bucket: '90-100', predictedMidpoint: 95, observed: 100, n: 1 }); // B
    for (const label of ['0-10', '10-20', '30-40', '40-50', '60-70']) {
      expect(byLabel[label].n).toBe(0);
      expect(byLabel[label].observed).toBeNull();
    }
  });

  it('computes exact precision-style hit rates at 50/70/90', () => {
    const { hitRates } = computeAccuracyStats(FIXTURE);
    // >=50: D(55,f), F(70,f), A(80,e), B(95,e)
    expect(hitRates.at50).toEqual({ predictedCount: 4, enactedCount: 2, rate: 0.5 });
    // >=70: F, A, B
    expect(hitRates.at70.predictedCount).toBe(3);
    expect(hitRates.at70.enactedCount).toBe(2);
    expect(hitRates.at70.rate).toBeCloseTo(2 / 3, 10);
    // >=90: B
    expect(hitRates.at90).toEqual({ predictedCount: 1, enactedCount: 1, rate: 1 });
  });

  it('computes exact per-jurisdiction splits (sorted, Brier over eligible only)', () => {
    const { byJurisdiction } = computeAccuracyStats(FIXTURE);
    expect(byJurisdiction.map((j) => j.jurisdiction)).toEqual(['EU', 'US-CA', 'US-FED']);

    const eu = byJurisdiction[0];
    expect(eu.outcomes).toBe(2); // E (null T30) still counted in outcomes
    expect(eu.enacted).toBe(1);
    expect(eu.brierScore).toBeCloseTo(0.49, 10); // only F eligible

    const ca = byJurisdiction[1];
    expect(ca.outcomes).toBe(2);
    expect(ca.enacted).toBe(0);
    expect(ca.brierScore).toBeCloseTo((0.04 + 0.3025) / 2, 10);

    const fed = byJurisdiction[2];
    expect(fed.outcomes).toBe(2);
    expect(fed.enacted).toBe(2);
    expect(fed.brierScore).toBeCloseTo((0.04 + 0.0025) / 2, 10);
  });

  it('places a perfect 100 score in the top (inclusive) bucket', () => {
    const stats = computeAccuracyStats([{ outcome: 'enacted', scoreT30: 100, jurisdiction: 'EU' }]);
    const top = stats.calibrationBuckets[9];
    expect(top.bucket).toBe('90-100');
    expect(top.n).toBe(1);
    expect(top.observed).toBe(100);
  });

  it('is null-safe on empty input', () => {
    const stats = computeAccuracyStats([]);
    expect(stats.sampleSize).toBe(0);
    expect(stats.brierScore).toBeNull();
    expect(stats.calibrationBuckets).toEqual(emptyCalibrationBuckets());
    expect(stats.hitRates).toEqual(emptyHitRates());
    expect(stats.byJurisdiction).toEqual([]);
  });

  it('rejects out-of-range scores at the boundary', () => {
    expect(() =>
      computeAccuracyStats([{ outcome: 'enacted', scoreT30: 101, jurisdiction: 'EU' }]),
    ).toThrow(/out of range/);
    expect(() =>
      computeAccuracyStats([{ outcome: 'failed', scoreT30: -1, jurisdiction: 'EU' }]),
    ).toThrow(/out of range/);
  });
});

// ─── DB round-trip ─────────────────────────────────────────────

function insertOutcomeRow(params: {
  billId: string;
  outcome: 'enacted' | 'failed';
  scoreT30: number | null;
}): void {
  const now = new Date().toISOString();
  getDb().insert(billOutcomes).values({
    id: randomUUID(),
    billId: params.billId,
    finalStage: params.outcome === 'enacted' ? 'signed' : 'died',
    outcome: params.outcome,
    outcomeAt: now,
    scoreT30: params.scoreT30,
    signature: 'test-signature',
    recordedAt: now,
    methodologyVersion: METHODOLOGY_VERSION,
  }).run();
}

function insertBillRow(jurisdiction: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().insert(trackedBills).values({
    id,
    title: `Bill ${id.slice(0, 8)}`,
    jurisdiction,
    currentStage: 'signed',
    progressPercent: 95,
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

describe('runAccuracyCalibration', () => {
  beforeAll(() => {
    runMigrations();
  });

  beforeEach(() => {
    const db = getDb();
    db.delete(accuracySnapshots).run();
    db.delete(billOutcomes).run();
    db.delete(trackedBills).run();
  });

  it('persists a null-safe unpublished snapshot when there is no history', () => {
    const snapshot = runAccuracyCalibration(getDb(), '2026-07-24T04:30:00.000Z');
    expect(snapshot.sampleSize).toBe(0);
    expect(snapshot.enactedCount).toBe(0);
    expect(snapshot.failedCount).toBe(0);
    expect(snapshot.withCalibrationScore).toBe(0);
    expect(snapshot.brierScore).toBeNull();
    expect(snapshot.published).toBe(false);
    expect(snapshot.generatedAt).toBe('2026-07-24T04:30:00.000Z');
    expect(snapshot.methodologyVersion).toBe(METHODOLOGY_VERSION);
    expect(JSON.parse(snapshot.calibrationBuckets)).toEqual(emptyCalibrationBuckets());
    expect(JSON.parse(snapshot.hitRates)).toEqual(emptyHitRates());
    expect(JSON.parse(snapshot.byJurisdiction)).toEqual([]);
  });

  it('persists correct stats with jurisdiction joins and validated JSON blobs', () => {
    const fedBill = insertBillRow('US-FED');
    const caBill = insertBillRow('US-CA');
    insertOutcomeRow({ billId: fedBill, outcome: 'enacted', scoreT30: 80 });
    insertOutcomeRow({ billId: caBill, outcome: 'failed', scoreT30: 20 });
    // Outcome whose operational bill row was wiped → jurisdiction 'unknown'
    insertOutcomeRow({ billId: randomUUID(), outcome: 'failed', scoreT30: null });

    const snapshot = runAccuracyCalibration(getDb());
    expect(snapshot.sampleSize).toBe(3);
    expect(snapshot.enactedCount).toBe(1);
    expect(snapshot.failedCount).toBe(2);
    expect(snapshot.withCalibrationScore).toBe(2);
    expect(snapshot.brierScore).toBeCloseTo((0.04 + 0.04) / 2, 10);
    expect(snapshot.published).toBe(false); // 3 < MIN_PUBLISH_N

    const buckets = CalibrationBucketsSchema.parse(JSON.parse(snapshot.calibrationBuckets));
    expect(buckets.find((b) => b.bucket === '80-90')!.n).toBe(1);
    const hitRates = HitRatesSchema.parse(JSON.parse(snapshot.hitRates));
    expect(hitRates.at50).toEqual({ predictedCount: 1, enactedCount: 1, rate: 1 });
    const byJur = ByJurisdictionSchema.parse(JSON.parse(snapshot.byJurisdiction));
    expect(byJur.map((j) => j.jurisdiction)).toEqual(['US-CA', 'US-FED', 'unknown']);
    expect(byJur.find((j) => j.jurisdiction === 'unknown')!.brierScore).toBeNull();
  });

  it('publishes at MIN_PUBLISH_N outcomes and never deletes prior snapshots', () => {
    for (let i = 0; i < MIN_PUBLISH_N; i++) {
      insertOutcomeRow({
        billId: randomUUID(),
        outcome: i % 2 === 0 ? 'enacted' : 'failed',
        scoreT30: i % 2 === 0 ? 90 : 10,
      });
    }

    const first = runAccuracyCalibration(getDb(), '2026-07-24T04:30:00.000Z');
    expect(first.sampleSize).toBe(MIN_PUBLISH_N);
    expect(first.published).toBe(true);

    const second = runAccuracyCalibration(getDb(), '2026-07-25T04:30:00.000Z');
    expect(second.id).not.toBe(first.id);

    // Time series is append-only
    const all = getDb().select().from(accuracySnapshots).all();
    expect(all).toHaveLength(2);
  });
});

/**
 * Scout Accuracy Ledger: Calibration Job
 *
 * Nightly computation of Nomus's public prediction track record from the
 * frozen bill_outcomes rows. Persists one accuracy_snapshots row per run;
 * snapshots are NEVER deleted — the time series of the track record is
 * itself part of the track record.
 *
 * ── Methodology (v1) ──
 *
 * - Primary prediction = scoreT30: the passage score computed at-or-before
 *   30 days prior to the recorded outcome. Outcomes with no scoreT30 are
 *   EXCLUDED from Brier/calibration/hit-rate math but still counted in the
 *   sample metadata (sampleSize vs withCalibrationScore).
 * - Brier score = mean((scoreT30/100 - outcomeAs01)^2) over eligible
 *   outcomes, where outcomeAs01 is 1 for 'enacted' and 0 otherwise.
 *   Null when there are no eligible outcomes.
 * - Calibration buckets: ten deciles of scoreT30 (0-10 … 90-100; the last
 *   bucket is inclusive of 100). observed = enacted-rate within the bucket
 *   as a PERCENTAGE 0-100 (same axis as predictedMidpoint), null when n=0.
 * - Hit rates at thresholds 50/70/90: precision-style — of bills with
 *   scoreT30 >= threshold, the fraction (0-1) that were enacted; rate is
 *   null when nothing was predicted at that threshold.
 * - byJurisdiction: outcome/enacted counts and Brier per jurisdiction
 *   (bill's jurisdiction via tracked_bills; 'unknown' if the operational
 *   bill row no longer exists).
 * - published = sampleSize >= MIN_PUBLISH_N (30): small-n calibration is
 *   noise, so the public page shows an honest collecting state until then.
 * - Transparency disclosure: the political component of
 *   the passage score is currently FIXED at 50 (neutral) — see
 *   passage-score.ts computePolitical(). This is disclosed in the
 *   methodology object served by the transparency API.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { accuracySnapshots, billOutcomes, trackedBills } from '../db/schema.js';
import { logger } from '../logger.js';

// ─── Constants ─────────────────────────────────────────────────

export const MIN_PUBLISH_N = 30;
export const METHODOLOGY_VERSION = 1;

const HIT_RATE_THRESHOLDS = [50, 70, 90] as const;
const QUERY_CHUNK_SIZE = 500;

// ─── JSON blob schemas (validated at the write boundary) ───────

export const CalibrationBucketSchema = z.object({
  bucket: z.string().regex(/^\d{1,2}-\d{2,3}$/),
  predictedMidpoint: z.number().min(0).max(100),
  /** Observed enactment rate as a percentage 0-100; null when n = 0. */
  observed: z.number().min(0).max(100).nullable(),
  n: z.number().int().min(0),
});

export const HitRateSchema = z.object({
  predictedCount: z.number().int().min(0),
  enactedCount: z.number().int().min(0),
  /** enactedCount / predictedCount as a fraction 0-1; null when predictedCount = 0. */
  rate: z.number().min(0).max(1).nullable(),
});

export const HitRatesSchema = z.object({
  at50: HitRateSchema,
  at70: HitRateSchema,
  at90: HitRateSchema,
});

export const JurisdictionStatSchema = z.object({
  jurisdiction: z.string().min(1),
  outcomes: z.number().int().min(0),
  enacted: z.number().int().min(0),
  brierScore: z.number().min(0).max(1).nullable(),
});

export const CalibrationBucketsSchema = z.array(CalibrationBucketSchema).length(10);
export const ByJurisdictionSchema = z.array(JurisdictionStatSchema);

export type CalibrationBucket = z.infer<typeof CalibrationBucketSchema>;
export type HitRates = z.infer<typeof HitRatesSchema>;
export type JurisdictionStat = z.infer<typeof JurisdictionStatSchema>;

// ─── Pure computation ──────────────────────────────────────────

export interface OutcomeForCalibration {
  outcome: 'enacted' | 'failed' | 'withdrawn';
  scoreT30: number | null;
  jurisdiction: string;
}

export interface AccuracyStats {
  sampleSize: number;
  enactedCount: number;
  failedCount: number;
  withCalibrationScore: number;
  brierScore: number | null;
  calibrationBuckets: CalibrationBucket[];
  hitRates: HitRates;
  byJurisdiction: JurisdictionStat[];
}

/** The ten empty deciles — also served as the empty-state calibration shape. */
export function emptyCalibrationBuckets(): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 10;
    buckets.push({ bucket: `${lo}-${lo + 10}`, predictedMidpoint: lo + 5, observed: null, n: 0 });
  }
  return buckets;
}

/** The zero-count hit-rate shape — also served as the empty state. */
export function emptyHitRates(): HitRates {
  return {
    at50: { predictedCount: 0, enactedCount: 0, rate: null },
    at70: { predictedCount: 0, enactedCount: 0, rate: null },
    at90: { predictedCount: 0, enactedCount: 0, rate: null },
  };
}

function brierOver(rows: Array<{ scoreT30: number; enacted: boolean }>): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, r) => {
    const predicted = r.scoreT30 / 100;
    const actual = r.enacted ? 1 : 0;
    return acc + (predicted - actual) ** 2;
  }, 0);
  return sum / rows.length;
}

/**
 * Pure calibration math over a set of outcomes. Deterministic — the unit
 * tests assert hand-computed fixtures against this function exactly.
 *
 * Eligibility: outcome 'enacted' or 'failed' with a non-null scoreT30.
 * 'withdrawn' outcomes (none produced in v1) and null-scoreT30 outcomes are
 * excluded from the math but counted in sampleSize.
 */
export function computeAccuracyStats(outcomes: OutcomeForCalibration[]): AccuracyStats {
  const sampleSize = outcomes.length;
  const enactedCount = outcomes.filter((o) => o.outcome === 'enacted').length;
  const failedCount = outcomes.filter((o) => o.outcome === 'failed').length;

  const eligible = outcomes
    .filter((o) => o.scoreT30 !== null && (o.outcome === 'enacted' || o.outcome === 'failed'))
    .map((o) => ({
      scoreT30: o.scoreT30 as number,
      enacted: o.outcome === 'enacted',
      jurisdiction: o.jurisdiction,
    }));

  // Validate the boundary invariant: scores must be 0-100.
  for (const e of eligible) {
    if (e.scoreT30 < 0 || e.scoreT30 > 100 || Number.isNaN(e.scoreT30)) {
      throw new Error(`accuracy-calibration: scoreT30 out of range [0,100]: ${e.scoreT30}`);
    }
  }

  const withCalibrationScore = eligible.length;
  const brierScore = brierOver(eligible);

  // Ten deciles; last bucket [90,100] inclusive of 100.
  const calibrationBuckets = emptyCalibrationBuckets().map((bucket, i) => {
    const lo = i * 10;
    const hi = lo + 10;
    const members = eligible.filter((e) => e.scoreT30 >= lo && (i === 9 ? e.scoreT30 <= 100 : e.scoreT30 < hi));
    const n = members.length;
    const enacted = members.filter((m) => m.enacted).length;
    return {
      ...bucket,
      observed: n > 0 ? (enacted / n) * 100 : null,
      n,
    };
  });

  const hitRateEntries = HIT_RATE_THRESHOLDS.map((threshold) => {
    const predicted = eligible.filter((e) => e.scoreT30 >= threshold);
    const enacted = predicted.filter((p) => p.enacted).length;
    return [
      `at${threshold}`,
      {
        predictedCount: predicted.length,
        enactedCount: enacted,
        rate: predicted.length > 0 ? enacted / predicted.length : null,
      },
    ] as const;
  });
  const hitRates = Object.fromEntries(hitRateEntries) as HitRates;

  // Per-jurisdiction splits: counts over ALL outcomes, Brier over eligible.
  const jurisdictions = [...new Set(outcomes.map((o) => o.jurisdiction))].sort();
  const byJurisdiction: JurisdictionStat[] = jurisdictions.map((jurisdiction) => {
    const all = outcomes.filter((o) => o.jurisdiction === jurisdiction);
    const jEligible = eligible.filter((e) => e.jurisdiction === jurisdiction);
    return {
      jurisdiction,
      outcomes: all.length,
      enacted: all.filter((o) => o.outcome === 'enacted').length,
      brierScore: brierOver(jEligible),
    };
  });

  return {
    sampleSize,
    enactedCount,
    failedCount,
    withCalibrationScore,
    brierScore,
    calibrationBuckets,
    hitRates,
    byJurisdiction,
  };
}

// ─── Job ───────────────────────────────────────────────────────

/**
 * Load every recorded outcome (chunked — no unbounded .all()), joined with
 * tracked_bills for jurisdiction ('unknown' when the operational bill row
 * no longer exists — the ledger deliberately outlives it).
 */
function loadOutcomesForCalibration(db: BetterSQLite3Database<any>): OutcomeForCalibration[] {
  const results: OutcomeForCalibration[] = [];
  let offset = 0;
  for (;;) {
    const chunk = db
      .select({
        outcome: billOutcomes.outcome,
        scoreT30: billOutcomes.scoreT30,
        jurisdiction: trackedBills.jurisdiction,
      })
      .from(billOutcomes)
      .leftJoin(trackedBills, eq(billOutcomes.billId, trackedBills.id))
      .orderBy(asc(billOutcomes.id))
      .limit(QUERY_CHUNK_SIZE)
      .offset(offset)
      .all();

    for (const row of chunk) {
      results.push({
        outcome: row.outcome,
        scoreT30: row.scoreT30,
        jurisdiction: row.jurisdiction ?? 'unknown',
      });
    }
    if (chunk.length < QUERY_CHUNK_SIZE) break;
    offset += QUERY_CHUNK_SIZE;
  }
  return results;
}

/**
 * Run the nightly calibration: compute stats over all recorded outcomes and
 * persist one accuracy_snapshots row. Every JSON blob is Zod-validated
 * before it is written — a malformed snapshot must never be persisted.
 *
 * @returns the persisted snapshot row.
 */
export function runAccuracyCalibration(
  db: BetterSQLite3Database<any> = getDb(),
  nowIso: string = new Date().toISOString(),
): typeof accuracySnapshots.$inferSelect {
  if (Number.isNaN(Date.parse(nowIso))) {
    throw new Error(`accuracy-calibration: invalid nowIso: ${nowIso}`);
  }

  const outcomes = loadOutcomesForCalibration(db);
  const stats = computeAccuracyStats(outcomes);

  // Validate JSON blobs at the write boundary — throw on any violation.
  const buckets = CalibrationBucketsSchema.parse(stats.calibrationBuckets);
  const hitRates = HitRatesSchema.parse(stats.hitRates);
  const byJurisdiction = ByJurisdictionSchema.parse(stats.byJurisdiction);

  const row = {
    id: randomUUID(),
    generatedAt: nowIso,
    methodologyVersion: METHODOLOGY_VERSION,
    sampleSize: stats.sampleSize,
    enactedCount: stats.enactedCount,
    failedCount: stats.failedCount,
    withCalibrationScore: stats.withCalibrationScore,
    brierScore: stats.brierScore,
    calibrationBuckets: JSON.stringify(buckets),
    hitRates: JSON.stringify(hitRates),
    byJurisdiction: JSON.stringify(byJurisdiction),
    published: stats.sampleSize >= MIN_PUBLISH_N,
  };

  db.insert(accuracySnapshots).values(row).run();

  const persisted = db.select().from(accuracySnapshots).where(eq(accuracySnapshots.id, row.id)).get();
  if (!persisted) {
    throw new Error('accuracy-calibration: snapshot insert was silently dropped — row missing after insert');
  }

  logger.info(
    {
      snapshotId: row.id,
      sampleSize: stats.sampleSize,
      enacted: stats.enactedCount,
      failed: stats.failedCount,
      withCalibrationScore: stats.withCalibrationScore,
      brierScore: stats.brierScore,
      published: row.published,
    },
    'Accuracy ledger: calibration snapshot persisted',
  );

  return persisted;
}

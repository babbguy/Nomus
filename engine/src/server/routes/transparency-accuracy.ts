/**
 * Scout Accuracy Ledger: Public Transparency API
 *
 * Fully public (no auth), matching the existing public transparency surface
 * (transparency.ts /stats and the public ledger routes carry no auth and no
 * rate-limit middleware — this module mirrors those conventions exactly).
 *
 * GET /api/v1/transparency/accuracy           — latest calibration snapshot
 * GET /api/v1/transparency/accuracy/outcomes  — signed per-bill outcome rows
 *
 * The response contract of both endpoints is frozen against the dashboard's
 * PublicTransparency page — do not change field names or shapes without a
 * methodologyVersion bump and a coordinated dashboard change.
 */

import { Hono } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { accuracySnapshots, billOutcomes, trackedBills } from '../../db/schema.js';
import {
  MIN_PUBLISH_N,
  METHODOLOGY_VERSION,
  emptyCalibrationBuckets,
  emptyHitRates,
} from '../../scout/accuracy-calibration.js';
import { safeParseInt } from '../utils.js';
import { LEGAL_DISCLAIMER } from '@nomus/shared';

export const transparencyAccuracyRoutes = new Hono();

// ─── Methodology ──

const METHODOLOGY = {
  version: METHODOLOGY_VERSION,
  primaryMetric:
    'scoreT30 — the passage score computed at-or-before 30 days prior to the recorded outcome. ' +
    'scoreT60/scoreT90 are stored per outcome for longer-horizon analysis.',
  exclusionRule:
    'Outcomes with no score history at T-30 are excluded from the Brier score, calibration buckets, ' +
    'and hit rates, but are counted in the sample totals (sample.outcomes vs sample.withCalibrationScore).',
  brierScore:
    'Mean of (scoreT30/100 - outcome)^2 over calibration-eligible outcomes, where outcome is 1 if enacted, 0 otherwise. ' +
    'Lower is better; 0.25 is the score of always predicting 50%.',
  calibrationUnits:
    'calibration[].predictedMidpoint and calibration[].observed are both percentages on a 0-100 scale; ' +
    'observed is null for buckets with n = 0. hitRates.*.rate is a fraction 0-1.',
  outcomeMapping:
    'enacted = signed, veto_override, awaiting_effective, in_force, or repealed (a repealed law WAS enacted — ' +
    'the passage prediction succeeded). failed = died. Vetoed bills remain PENDING — no outcome is frozen at ' +
    'veto time, because a veto can still be overridden; they resolve on veto_override (enacted), died (failed), ' +
    'or session end. Stalled and vetoed bills are only marked failed when their US federal biennium ends ' +
    '(noon UTC, January 3 of odd years); non-US-FED session calendars are not yet modeled, so those outcomes ' +
    'are recorded only on terminal stage transitions.',
  knownLimitations: [
    'The political component of the passage score is fixed at 50 (neutral) pending external administration-priority data. ' +
      'It is included, at that fixed value, in every componentSnapshot for reproducibility.',
  ],
  minPublishN:
    `Calibration is published only when the sample holds at least ${MIN_PUBLISH_N} outcomes — ` +
    'small-sample calibration is statistical noise, and an honest empty state beats a misleading chart.',
  verification:
    'Every outcome row is Ed25519-signed over the canonical JSON of the record minus its signature field. ' +
    'The public key is served at /.well-known/nomus-public-key.',
} as const;

// ─── GET / — latest calibration snapshot ───────────────────────

transparencyAccuracyRoutes.get('/', (c) => {
  const db = getDb();

  const latest = db
    .select()
    .from(accuracySnapshots)
    .orderBy(desc(accuracySnapshots.generatedAt))
    .limit(1)
    .get();

  if (!latest) {
    // Honest empty state: same shape, zero sample, nothing published yet.
    return c.json({
      methodologyVersion: METHODOLOGY_VERSION,
      generatedAt: new Date().toISOString(),
      sample: { outcomes: 0, enacted: 0, failed: 0, withCalibrationScore: 0 },
      brierScore: null,
      calibration: emptyCalibrationBuckets(),
      hitRates: emptyHitRates(),
      byJurisdiction: [],
      minPublishN: MIN_PUBLISH_N,
      published: false,
      methodology: METHODOLOGY,
      _disclaimer: LEGAL_DISCLAIMER,
    });
  }

  return c.json({
    methodologyVersion: latest.methodologyVersion,
    generatedAt: latest.generatedAt,
    sample: {
      outcomes: latest.sampleSize,
      enacted: latest.enactedCount,
      failed: latest.failedCount,
      withCalibrationScore: latest.withCalibrationScore,
    },
    brierScore: latest.brierScore,
    calibration: JSON.parse(latest.calibrationBuckets),
    hitRates: JSON.parse(latest.hitRates),
    byJurisdiction: JSON.parse(latest.byJurisdiction),
    minPublishN: MIN_PUBLISH_N,
    published: latest.published,
    methodology: METHODOLOGY,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

// ─── GET /outcomes — signed per-bill outcome records ───────────

transparencyAccuracyRoutes.get('/outcomes', (c) => {
  const db = getDb();

  // Validate pagination at the boundary: limit 1..200 (default 50), offset >= 0.
  const limit = Math.min(200, Math.max(1, safeParseInt(c.req.query('limit'), 50)));
  const offset = Math.max(0, safeParseInt(c.req.query('offset'), 0));

  const totalRow = db.select({ count: sql<number>`count(*)` }).from(billOutcomes).get();

  const rows = db
    .select({
      id: billOutcomes.id,
      billId: billOutcomes.billId,
      title: trackedBills.title,
      jurisdiction: trackedBills.jurisdiction,
      outcome: billOutcomes.outcome,
      finalStage: billOutcomes.finalStage,
      outcomeAt: billOutcomes.outcomeAt,
      scoreT30: billOutcomes.scoreT30,
      scoreT60: billOutcomes.scoreT60,
      scoreT90: billOutcomes.scoreT90,
      peakScore: billOutcomes.peakScore,
      scoreAtOutcome: billOutcomes.scoreAtOutcome,
      recordedAt: billOutcomes.recordedAt,
      signature: billOutcomes.signature,
    })
    .from(billOutcomes)
    .leftJoin(trackedBills, eq(billOutcomes.billId, trackedBills.id))
    .orderBy(desc(billOutcomes.outcomeAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({
    total: totalRow?.count ?? 0,
    entries: rows,
    _disclaimer: LEGAL_DISCLAIMER,
  });
});

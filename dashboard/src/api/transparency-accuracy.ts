// ─── Scout Accuracy Ledger — public transparency API ────
//
// These are PUBLIC, unauthenticated endpoints. They use plain fetch
// (matching how PublicTransparency.tsx calls /api/v1/transparency/stats)
// instead of the shared axios client, because the client attaches
// credentials and its 401 interceptor redirects to /login — behavior
// that must never apply to the public transparency page.
//
// Scale conventions (documented so a contract mismatch is a one-line fix):
// - Bill scores (scoreT30/T60/T90, peakScore, scoreAtOutcome) are 0–100
//   integers, matching Scout's passage-score composite.
// - predictedMidpoint is 0–100 (midpoint of the percent bucket, e.g. "0-10" → 5).
// - calibration `observed` is a percentage 0-100 (same axis as predictedMidpoint,
//   per the engine's methodology.calibrationUnits); hit rates are fractions in [0, 1].
// - brierScore is in [0, 1]; lower is better (0.25 ≈ always guessing 50%).

// ─── Types (contract: GET /api/v1/transparency/accuracy) ────────

export interface AccuracySample {
  /** Total terminal bill outcomes recorded. */
  outcomes: number;
  enacted: number;
  failed: number;
  /** Outcomes that had a score on record 30 days before the outcome (calibration basis). */
  withCalibrationScore: number;
}

export interface CalibrationBucket {
  /** Predicted-probability band, percent — e.g. "0-10", "10-20", … "90-100". */
  bucket: string;
  /** Midpoint of the band, 0–100. */
  predictedMidpoint: number;
  /** Observed pass rate for the bucket as a fraction [0, 1]; null when the bucket is empty. */
  observed: number | null;
  /** Number of outcomes in the bucket. */
  n: number;
}

export interface HitRate {
  /** Bills whose T-30 score met the threshold. */
  predictedCount: number;
  /** Of those, how many were actually enacted. */
  enactedCount: number;
  /** enactedCount / predictedCount as a fraction [0, 1]; null when predictedCount is 0. */
  rate: number | null;
}

export interface HitRates {
  at50: HitRate;
  at70: HitRate;
  at90: HitRate;
}

export interface JurisdictionAccuracy {
  jurisdiction: string;
  outcomes: number;
  enacted: number;
  brierScore: number | null;
}

export interface AccuracySnapshot {
  methodologyVersion: string | number;
  /** UTC ISO-8601 — when this snapshot was computed. */
  generatedAt: string;
  sample: AccuracySample;
  /** [0, 1], lower is better; null until enough scored outcomes exist. */
  brierScore: number | null;
  /** Exactly 10 buckets, "0-10" … "90-100". */
  calibration: CalibrationBucket[];
  hitRates: HitRates;
  byJurisdiction: JurisdictionAccuracy[];
  /** Calibration statistics publish only once sample.outcomes >= minPublishN. */
  minPublishN: number;
  published: boolean;
}

// ─── Types (contract: GET /api/v1/transparency/accuracy/outcomes) ──

export type BillOutcomeKind = 'enacted' | 'failed' | 'withdrawn';

export interface OutcomeEntry {
  id: string | number;
  billId: string;
  title: string;
  jurisdiction: string;
  outcome: BillOutcomeKind;
  /** Terminal lifecycle stage the bill ended in (e.g. "signed", "died"). */
  finalStage: string;
  /** UTC ISO-8601 — when the bill reached its terminal stage. */
  outcomeAt: string;
  /** Passage score (0–100) 30 days before outcome; null if no score existed then. */
  scoreT30: number | null;
  scoreT60: number | null;
  scoreT90: number | null;
  peakScore: number | null;
  scoreAtOutcome: number | null;
  /** UTC ISO-8601 — when the outcome row was frozen. */
  recordedAt: string;
  /** Ed25519 signature over the canonical JSON of the record. */
  signature: string;
}

export interface OutcomesResponse {
  total: number;
  entries: OutcomeEntry[];
}

// ─── Fetchers ───────────────────────────────────────────────────

async function getPublicJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchAccuracySnapshot(): Promise<AccuracySnapshot> {
  return getPublicJson<AccuracySnapshot>('/api/v1/transparency/accuracy');
}

export function fetchAccuracyOutcomes(limit = 15, offset = 0): Promise<OutcomesResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return getPublicJson<OutcomesResponse>(`/api/v1/transparency/accuracy/outcomes?${params.toString()}`);
}

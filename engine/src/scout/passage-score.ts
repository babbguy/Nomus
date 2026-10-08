import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { trackedBills, billScoreHistory } from '../db/schema.js';
import { recordOutcomeIfTerminal } from './outcome-recorder.js';
import { logger } from '../logger.js';

// ─── Interfaces ────────────────────────────────────────────────

export interface PassageScore {
  total: number;           // 0-100 composite
  components: {
    momentum: number;      // 0-100, weight 30%
    baseRate: number;      // 0-100, weight 25%
    sponsorStrength: number; // 0-100, weight 15%
    sentiment: number;     // 0-100, weight 10%
    political: number;     // 0-100, weight 10%
    opposition: number;    // 0-100, weight 10%
  };
  stalenessPenalty: number; // 0 to -40
  computedAt: string;       // ISO 8601
}

export interface BillContext {
  currentStage: string;
  lastActionDate: string;      // ISO 8601
  introducedDate?: string;
  jurisdiction: string;
  session?: string;
  sponsors?: SponsorInfo[];
  newsArticles?: NewsArticle[];
}

export interface SponsorInfo {
  name: string;
  party?: string;
  isCommitteeChair: boolean;
  isLeadership: boolean;
  isPrimary: boolean;
}

export interface NewsArticle {
  sentiment: 'supportive' | 'opposed' | 'neutral' | 'mixed';
  sentimentScore?: number;  // -1 to 1
}

// ─── Component Weights ─────────────────────────────────────────

const WEIGHTS = {
  momentum: 0.30,
  baseRate: 0.25,
  sponsorStrength: 0.15,
  sentiment: 0.10,
  political: 0.10,
  opposition: 0.10,
} as const;

// ─── Historical Base Rates by Stage ────────────────────────────

const STAGE_BASE_RATES: Record<string, number> = {
  'rumor': 5,
  'executive_order': 5,
  'draft_circulated': 8,
  'introduced': 12,
  'committee_referred': 15,
  'committee_hearing': 25,
  'committee_markup': 35,
  'committee_passed': 50,
  'floor_scheduled': 60,
  'floor_debate': 65,
  'floor_vote': 75,
  'passed_origin': 80,
  'second_committee': 82,
  'second_floor': 85,
  'passed_second': 90,
  'conference': 88,
  'sent_to_executive': 92,
  'executive_review': 93,
  'signed': 100,
  'in_force': 100,
  'vetoed': 15,
  'died': 0,
  'stalled': 0,
};

// ─── Terminal Stages (always score 0) ──────────────────────────

const TERMINAL_STAGES = new Set(['died', 'stalled']);

// ─── Component Calculators ─────────────────────────────────────

/**
 * Calculate days between two ISO 8601 dates.
 * Returns a non-negative integer.
 */
export function daysBetween(dateA: string, dateB: string): number {
  const msPerDay = 86_400_000;
  const a = new Date(dateA).getTime();
  const b = new Date(dateB).getTime();
  return Math.max(0, Math.floor(Math.abs(b - a) / msPerDay));
}

/**
 * Momentum score based on recency of legislative action.
 * More recent action = higher momentum.
 */
export function computeMomentum(lastActionDate: string, now: string): number {
  const days = daysBetween(lastActionDate, now);

  if (days <= 7) return 95;
  if (days <= 14) return 85;
  if (days <= 30) return 70;
  if (days <= 60) return 45;
  if (days <= 90) return 25;
  return 10;
}

/**
 * Historical base rate for the current legislative stage.
 * US Congress baseline probabilities.
 */
export function computeBaseRate(currentStage: string): number {
  const normalized = currentStage.toLowerCase().replace(/\s+/g, '_');
  return STAGE_BASE_RATES[normalized] ?? 10;
}

/**
 * Sponsor strength based on sponsor characteristics.
 * Committee chairs, leadership, bipartisanship, and cosponsor count all contribute.
 */
export function computeSponsorStrength(sponsors?: SponsorInfo[]): number {
  if (!sponsors || sponsors.length === 0) return 30;

  let score = 30;

  const hasChair = sponsors.some((s) => s.isPrimary && s.isCommitteeChair);
  if (hasChair) score += 30;

  const hasLeadership = sponsors.some((s) => s.isLeadership);
  if (hasLeadership) score += 20;

  // Bipartisan check: sponsors from at least two different parties
  const parties = new Set(
    sponsors
      .filter((s) => s.party != null && s.party !== '')
      .map((s) => s.party),
  );
  if (parties.size >= 2) score += 15;

  // Cosponsor count bonus: count non-primary sponsors
  const cosponsorCount = sponsors.filter((s) => !s.isPrimary).length;
  score += Math.min(cosponsorCount * 0.5, 10);

  return Math.min(100, score);
}

/**
 * Media sentiment score based on news coverage.
 * Supportive coverage = higher score.
 * Articles older than 30 days count at 50% weight (handled by caller if needed).
 */
export function computeSentiment(articles?: NewsArticle[]): number {
  if (!articles || articles.length === 0) return 50;

  const total = articles.length;
  const supportiveCount = articles.filter((a) => a.sentiment === 'supportive').length;
  return Math.round((supportiveCount / total) * 100);
}

/**
 * Political alignment score.
 * Defaults to 50 (neutral) until external administration priority data is available.
 */
export function computePolitical(): number {
  return 50;
}

/**
 * Industry opposition score.
 * Higher score = less opposition = more likely to pass.
 */
export function computeOpposition(articles?: NewsArticle[]): number {
  if (!articles || articles.length === 0) return 70;

  const total = articles.length;
  const opposedCount = articles.filter((a) => a.sentiment === 'opposed').length;
  const ratio = opposedCount / total;

  if (ratio > 0.5) return 30;
  if (ratio > 0.3) return 50;
  return 70;
}

/**
 * Staleness penalty applied to bills with no recent action.
 * Returns a negative number (0 to -40).
 */
export function computeStalenessPenalty(lastActionDate: string, now: string): number {
  const days = daysBetween(lastActionDate, now);

  if (days > 90) return -40;
  if (days > 60) return -25;
  if (days > 30) return -10;
  return 0;
}

// ─── Composite Score ───────────────────────────────────────────

/**
 * Compute the full passage score for a bill.
 * Pure function — no side effects, fully deterministic for the same inputs.
 */
export function computePassageScore(context: BillContext, now?: string): PassageScore {
  const computedAt = now ?? new Date().toISOString();

  // Terminal stages always return 0
  const normalizedStage = context.currentStage.toLowerCase().replace(/\s+/g, '_');
  if (TERMINAL_STAGES.has(normalizedStage)) {
    return {
      total: 0,
      components: {
        momentum: 0,
        baseRate: 0,
        sponsorStrength: 0,
        sentiment: 0,
        political: 0,
        opposition: 0,
      },
      stalenessPenalty: 0,
      computedAt,
    };
  }

  const components = {
    momentum: computeMomentum(context.lastActionDate, computedAt),
    baseRate: computeBaseRate(context.currentStage),
    sponsorStrength: computeSponsorStrength(context.sponsors),
    sentiment: computeSentiment(context.newsArticles),
    political: computePolitical(),
    opposition: computeOpposition(context.newsArticles),
  };

  const stalenessPenalty = computeStalenessPenalty(context.lastActionDate, computedAt);

  const weighted =
    components.momentum * WEIGHTS.momentum +
    components.baseRate * WEIGHTS.baseRate +
    components.sponsorStrength * WEIGHTS.sponsorStrength +
    components.sentiment * WEIGHTS.sentiment +
    components.political * WEIGHTS.political +
    components.opposition * WEIGHTS.opposition;

  const total = Math.max(0, Math.min(100, Math.round(weighted + stalenessPenalty)));

  return {
    total,
    components,
    stalenessPenalty,
    computedAt,
  };
}

// ─── Persistence ───────────────────────────────────────────────

/**
 * Record a passage score snapshot into bill_score_history.
 * Drizzle-typed (was raw SQL referencing phantom columns —).
 */
export function recordScore(
  db: BetterSQLite3Database<any>,
  billId: string,
  score: PassageScore,
): void {
  db.insert(billScoreHistory).values({
    billId,
    score: score.total,
    momentum: score.components.momentum,
    baseRate: score.components.baseRate,
    sponsorStrength: score.components.sponsorStrength,
    sentiment: score.components.sentiment,
    political: score.components.political,
    opposition: score.components.opposition,
    computedAt: score.computedAt,
  }).run();
}

/**
 * Compute a passage score, persist it, and update the tracked_bills row.
 * Returns the computed score.
 *
 * Note: the previous raw-SQL implementation referenced columns that did NOT
 * exist in the schema (momentum_score, base_rate_score, ..., score_computed_at,
 * staleness_penalty). It would have crashed at runtime as soon as it was
 * called. The Drizzle rewrite below uses the actual schema columns.
 */
export function computeAndRecordScore(
  db: BetterSQLite3Database<any>,
  billId: string,
  context: BillContext,
): PassageScore {
  const score = computePassageScore(context);

  db.update(trackedBills)
    .set({
      passageScore: score.total,
      passageMomentum: score.components.momentum,
      passageBaseRate: score.components.baseRate,
      passageSponsorStrength: score.components.sponsorStrength,
      passageSentiment: score.components.sentiment,
      passagePolitical: score.components.political,
      passageOpposition: score.components.opposition,
      lastScoreDate: score.computedAt,
      updatedAt: score.computedAt,
    })
    .where(eq(trackedBills.id, billId))
    .run();

  recordScore(db, billId, score);

  // Accuracy ledger: if this bill sits in a stage that maps to a
  // terminal outcome, make sure its outcome row is frozen. Idempotent
  // (exactly-once on billId); throws on signing failure — never skips.
  // Stage transitions themselves go through updateBillStage() in
  // outcome-recorder.ts; this is the defensive hook for bills that are
  // re-scored while already terminal.
  recordOutcomeIfTerminal(billId, db);

  logger.info(
    { billId, total: score.total, components: score.components },
    'Passage score computed and recorded',
  );

  return score;
}

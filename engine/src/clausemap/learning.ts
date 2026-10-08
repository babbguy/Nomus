/**
 * Clause Map learning loop.
 *
 * Feedback on a clause match updates the mapping's Beta-Bernoulli evidence:
 *   confirm → confirmedWeight += 1
 *   dismiss → dismissedWeight += 1
 *   posterior = (priorAlpha + confirmed) / (priorAlpha + priorBeta + confirmed + dismissed)
 *
 * Deterministic, monotone in evidence, and every update appends a
 * clause_learning_events row with the posterior before/after — the entire
 * learning trajectory is reconstructable from the event log (bank-grade:
 * zero silent state changes).
 */

import { eq, and, desc } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { clauseMappings, clauseMatches, clauseLearningEvents } from '../db/schema.js';
import { posteriorMean } from './dataset.js';

export interface FeedbackResult {
  matchId: string;
  mappingKey: string;
  status: 'confirmed' | 'dismissed';
  posteriorBefore: number;
  posteriorAfter: number;
}

/**
 * Apply confirm/dismiss feedback to a clause match (org-scoped).
 * Returns null when the match doesn't exist or belongs to another org.
 * Feedback on an already-resolved match re-resolves it but only counts
 * once toward learning (weight moves only on a status CHANGE).
 */
export function applyMatchFeedback(
  db: BetterSQLite3Database<Record<string, unknown>>,
  orgId: string,
  matchId: string,
  verdict: 'confirm' | 'dismiss',
  note?: string,
): FeedbackResult | null {
  const now = new Date().toISOString();

  const match = db
    .select()
    .from(clauseMatches)
    .where(and(eq(clauseMatches.id, matchId), eq(clauseMatches.orgId, orgId)))
    .get();
  if (!match) return null;

  const mapping = db
    .select()
    .from(clauseMappings)
    .where(eq(clauseMappings.id, match.mappingId))
    .get();
  if (!mapping) return null;

  const newStatus = verdict === 'confirm' ? 'confirmed' : 'dismissed';
  const posteriorBefore = mapping.posterior;

  // Compute the learning delta as a status transition, so flip-flopping
  // feedback stays consistent instead of double-counting:
  //   open → confirmed:      +1 confirm
  //   open → dismissed:      +1 dismiss
  //   confirmed → dismissed: -1 confirm, +1 dismiss
  //   dismissed → confirmed: +1 confirm, -1 dismiss
  //   X → X:                 no delta
  let dConfirmed = 0;
  let dDismissed = 0;
  if (match.status !== newStatus) {
    if (match.status === 'confirmed') dConfirmed -= 1;
    if (match.status === 'dismissed') dDismissed -= 1;
    if (newStatus === 'confirmed') dConfirmed += 1;
    if (newStatus === 'dismissed') dDismissed += 1;
  }

  const confirmedWeight = Math.max(0, mapping.confirmedWeight + dConfirmed);
  const dismissedWeight = Math.max(0, mapping.dismissedWeight + dDismissed);
  const posteriorAfter = posteriorMean(
    mapping.priorAlpha,
    mapping.priorBeta,
    confirmedWeight,
    dismissedWeight,
  );

  db.update(clauseMatches)
    .set({ status: newStatus, resolvedAt: now })
    .where(eq(clauseMatches.id, matchId))
    .run();

  if (dConfirmed !== 0 || dDismissed !== 0) {
    db.update(clauseMappings)
      .set({ confirmedWeight, dismissedWeight, posterior: posteriorAfter, updatedAt: now })
      .where(eq(clauseMappings.id, mapping.id))
      .run();
  }

  db.insert(clauseLearningEvents).values({
    mappingId: mapping.id,
    eventType: verdict === 'confirm' ? 'feedback_confirm' : 'feedback_dismiss',
    orgId,
    matchId,
    posteriorBefore,
    posteriorAfter,
    detailsJson: JSON.stringify({
      previousStatus: match.status,
      note: note ?? null,
      confirmedWeight,
      dismissedWeight,
    }),
    createdAt: now,
  }).run();

  return {
    matchId,
    mappingKey: mapping.mappingKey,
    status: newStatus,
    posteriorBefore,
    posteriorAfter,
  };
}

/** Recent learning events for one mapping (accuracy trajectory for the UI). */
export function learningHistory(
  db: BetterSQLite3Database<Record<string, unknown>>,
  mappingId: string,
  limit = 50,
) {
  return db
    .select()
    .from(clauseLearningEvents)
    .where(eq(clauseLearningEvents.mappingId, mappingId))
    .orderBy(desc(clauseLearningEvents.createdAt), desc(clauseLearningEvents.id))
    .limit(Math.min(limit, 200))
    .all();
}

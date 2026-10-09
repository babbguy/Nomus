// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

/**
 * Store and invalidation for the per-org compliance score cache.
 *
 * The score (`routes/compliance-posture.ts`) is cached for 30 s, but it is
 * computed from several tables. Every runtime write to one of them must drop
 * the cached entry AFTER the write has committed, or every surface that shows
 * the score (Posture, dashboard, badge, GitHub Action, VS Code) presents old
 * numbers as current:
 *
 *   policy_rules      global; use invalidateAllComplianceScores()
 *   ai_bom_systems    per org; use invalidateComplianceScore(orgId)
 *   benchmark_runs    per org
 *   scan_findings     per org
 *   organizations     per org (jurisdiction access)
 *
 * `compliance-score-cache.test.ts` fails when a source file writes one of
 * those tables without calling an invalidation function.
 */

export interface ScoreCacheEntry<T = unknown> {
  result: T;
  computedAt: string;
  expiresAt: number;
}

export const scoreCache = new Map<string, ScoreCacheEntry>();

/** Drop one org's cached score. Call after the write has committed. */
export function invalidateComplianceScore(orgId: string): void {
  scoreCache.delete(orgId);
}

/**
 * Drop every org's cached score. Rules are global, so any rule change moves
 * every org's score. Call after the write has committed.
 */
export function invalidateAllComplianceScores(): void {
  scoreCache.clear();
}

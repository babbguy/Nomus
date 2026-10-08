import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyFeedback, policyRules } from '../db/schema.js';

export interface FeedbackSummary {
  ruleId: string;
  ruleKey: string;
  totalFeedback: number;
  falsePositives: number;
  falseNegatives: number;
  inaccurate: number;
  helpful: number;
  accuracyScore: number; // 0-1, higher = more accurate
}

/**
 * Aggregate feedback signals across all rules.
 * Rules with high false positive/negative rates should have their
 * LLM prompts refined in future pipeline runs.
 */
export function getFeedbackSummary(): FeedbackSummary[] {
  const db = getDb();

  // Get all rules with feedback
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const summaries: FeedbackSummary[] = [];

  for (const rule of rules) {
    const feedback = db.select().from(policyFeedback)
      .where(eq(policyFeedback.ruleId, rule.id))
      .all();

    if (feedback.length === 0) continue;

    const falsePositives = feedback.filter((f) => f.feedbackType === 'false_positive').length;
    const falseNegatives = feedback.filter((f) => f.feedbackType === 'false_negative').length;
    const inaccurate = feedback.filter((f) => f.feedbackType === 'inaccurate').length;
    const helpful = feedback.filter((f) => f.feedbackType === 'helpful').length;

    const negativeCount = falsePositives + falseNegatives + inaccurate;
    const accuracyScore = feedback.length > 0
      ? 1 - (negativeCount / feedback.length)
      : 1;

    summaries.push({
      ruleId: rule.id,
      ruleKey: rule.ruleKey,
      totalFeedback: feedback.length,
      falsePositives,
      falseNegatives,
      inaccurate,
      helpful,
      accuracyScore,
    });
  }

  // Sort by worst accuracy first
  return summaries.sort((a, b) => a.accuracyScore - b.accuracyScore);
}

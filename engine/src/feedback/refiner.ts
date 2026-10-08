import { eq, sql, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules, policyFeedback } from '../db/schema.js';
import { logger } from '../logger.js';

interface FeedbackSummary {
  ruleId: string;
  ruleKey: string;
  total: number;
  falsePositives: number;
  falseNegatives: number;
  inaccurate: number;
  helpful: number;
  accuracyScore: number;
  comments: string[];
}

/**
 * Analyze feedback for all rules and identify low-accuracy rules.
 * Returns rules with accuracy < threshold, sorted worst-first.
 */
export function getLowAccuracyRules(threshold = 0.7): FeedbackSummary[] {
  const db = getDb();

  // Get all rules with feedback
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const results: FeedbackSummary[] = [];

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
    const accuracyScore = 1 - (negativeCount / feedback.length);

    if (accuracyScore < threshold) {
      const comments = feedback
        .filter((f) => f.description && f.feedbackType !== 'helpful')
        .map((f) => `[${f.feedbackType}] ${f.description}`)
        .slice(0, 10); // Cap at 10 comments for prompt injection

      results.push({
        ruleId: rule.id,
        ruleKey: rule.ruleKey,
        total: feedback.length,
        falsePositives,
        falseNegatives,
        inaccurate,
        helpful,
        accuracyScore,
        comments,
      });
    }
  }

  return results.sort((a, b) => a.accuracyScore - b.accuracyScore);
}

/**
 * Build a feedback context string for the translator prompt.
 * Injected during Step 3 of the pipeline to help the LLM avoid known mistakes.
 */
export function buildFeedbackContext(jurisdiction: string): string {
  const lowAccuracy = getLowAccuracyRules(0.7);
  const relevant = lowAccuracy.filter((r) => r.ruleKey.startsWith(jurisdiction.toLowerCase()));

  if (relevant.length === 0) return '';

  let context = '\n\nFEEDBACK REFINEMENT — These rules received negative feedback from users. Adjust your interpretation accordingly:\n';

  for (const rule of relevant.slice(0, 5)) {
    context += `\n- Rule "${rule.ruleKey}" (accuracy: ${Math.round(rule.accuracyScore * 100)}%):\n`;
    for (const comment of rule.comments.slice(0, 3)) {
      context += `  ${comment}\n`;
    }
  }

  context += '\nConsider these corrections when generating rules for this jurisdiction.\n';
  return context;
}

/**
 * Get accuracy scores for all rules (for dashboard display).
 */
export function getRuleAccuracyScores(): Array<{
  ruleId: string;
  ruleKey: string;
  jurisdiction: string;
  feedbackCount: number;
  accuracyScore: number;
  needsReview: boolean;
}> {
  const db = getDb();
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const results = [];

  for (const rule of rules) {
    const feedback = db.select().from(policyFeedback)
      .where(eq(policyFeedback.ruleId, rule.id))
      .all();

    if (feedback.length === 0) continue;

    const negativeCount = feedback.filter((f) =>
      ['false_positive', 'false_negative', 'inaccurate'].includes(f.feedbackType),
    ).length;
    const accuracyScore = 1 - (negativeCount / feedback.length);

    results.push({
      ruleId: rule.id,
      ruleKey: rule.ruleKey,
      jurisdiction: rule.jurisdiction,
      feedbackCount: feedback.length,
      accuracyScore: Math.round(accuracyScore * 100) / 100,
      needsReview: accuracyScore < 0.7,
    });
  }

  return results.sort((a, b) => a.accuracyScore - b.accuracyScore);
}

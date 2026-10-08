import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyFeedback, policyRules } from '../db/schema.js';

/**
 * Record customer feedback on a policy rule.
 */
export function submitFeedback(
  orgId: string,
  ruleId: string,
  feedbackType: 'false_positive' | 'false_negative' | 'inaccurate' | 'helpful',
  description?: string,
): { id: string } | null {
  const db = getDb();

  // Verify rule exists
  const rule = db.select({ id: policyRules.id })
    .from(policyRules)
    .where(eq(policyRules.id, ruleId))
    .get();

  if (!rule) return null;

  const id = randomUUID();
  db.insert(policyFeedback).values({
    id,
    orgId,
    ruleId,
    feedbackType,
    description: description ?? null,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }).run();

  return { id };
}

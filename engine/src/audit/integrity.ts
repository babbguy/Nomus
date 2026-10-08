import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { policyRules } from '../db/schema.js';
import { verifyRuleSignature } from '../core/rule-signing.js';
import { logger } from '../logger.js';

/**
 * Verify the integrity of all active policy rules.
 * Checks that each rule's signature matches its content.
 * Detects any tampering or corruption.
 */
export function verifyIntegrity(): {
  total: number;
  valid: number;
  corrupted: string[];
} {
  const db = getDb();
  const rules = db.select().from(policyRules)
    .where(eq(policyRules.isActive, true))
    .all();

  const corrupted: string[] = [];

  for (const rule of rules) {
    try {
      const valid = verifyRuleSignature(rule);
      if (!valid) {
        corrupted.push(rule.ruleKey);
        logger.error({ ruleKey: rule.ruleKey }, 'INTEGRITY VIOLATION: Rule signature mismatch');
      }
    } catch {
      corrupted.push(rule.ruleKey);
      logger.error({ ruleKey: rule.ruleKey }, 'INTEGRITY VIOLATION: Signature verification failed');
    }
  }

  if (corrupted.length > 0) {
    logger.error({ corrupted }, `INTEGRITY CHECK FAILED: ${corrupted.length} corrupted rules`);
  } else {
    logger.info({ total: rules.length }, 'Integrity check passed — all rules verified');
  }

  return {
    total: rules.length,
    valid: rules.length - corrupted.length,
    corrupted,
  };
}

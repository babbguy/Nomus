/**
 * Upsert of one extracted rule, shared by the Hunter pipeline and the Forge
 * worker. Rules are keyed by `ruleKey`; an existing rule gets its version
 * bumped and re-signed. A rule that a person created or edited (`locked`) is
 * never overwritten: extraction skips it so manual corrections survive the
 * next scrape.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PolicyEffect, PolicySeverity } from '@nomus/shared';
import { policyEvents, policyRules } from '../db/schema.js';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { signRule } from './rule-signing.js';
import type { DbHandle } from './rule-management.js';

export interface ExtractedRule {
  ruleKey: string;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt?: string | null;
  industries?: string[];
  industryScope?: string;
  industryNotes?: string;
}

export type UpsertOutcome = 'created' | 'updated' | 'skipped_locked';

export function upsertExtractedRule(
  tx: DbHandle,
  ctx: { sourceId: string; now: string; nextSequence: () => number },
  rule: ExtractedRule,
): UpsertOutcome {
  const existing = tx.select().from(policyRules)
    .where(eq(policyRules.ruleKey, rule.ruleKey))
    .get();

  if (existing?.locked) {
    logger.info(
      { ruleKey: rule.ruleKey, ruleId: existing.id },
      'Skipped re-extracted rule: it was edited by a person and is locked',
    );
    return 'skipped_locked';
  }

  if (existing) {
    const newVersion = existing.version + 1;
    const signature = signRule({ ...rule, version: newVersion });
    tx.update(policyRules).set({
      version: newVersion,
      conditions: JSON.stringify(rule.conditions),
      // Extracted rules carry effect/severity as free strings; the DB column
      // constrains them to the policy enums (validated upstream).
      effect: rule.effect as PolicyEffect,
      severity: rule.severity as PolicySeverity,
      humanSummary: rule.humanSummary,
      legalReference: rule.legalReference,
      effectiveDate: rule.effectiveDate,
      expiresAt: rule.expiresAt ?? null,
      signature,
      updatedAt: ctx.now,
    }).where(eq(policyRules.id, existing.id)).run();

    tx.insert(policyEvents).values({
      id: randomUUID(),
      eventType: 'policy.updated',
      ruleId: existing.id,
      payload: JSON.stringify({ ...rule, version: newVersion }),
      payloadSignature: signature,
      sequence: ctx.nextSequence(),
      createdAt: ctx.now,
    }).run();
    return 'updated';
  }

  const ruleId = randomUUID();
  const signature = signRule({ ...rule, version: 1 });
  tx.insert(policyRules).values({
    id: ruleId,
    sourceId: ctx.sourceId,
    ruleKey: rule.ruleKey,
    version: 1,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditions: JSON.stringify(rule.conditions),
    effect: rule.effect as PolicyEffect,
    severity: rule.severity as PolicySeverity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
    effectiveDate: rule.effectiveDate,
    expiresAt: rule.expiresAt ?? null,
    industries: JSON.stringify(rule.industries ?? ['all']),
    industryScope: rule.industryScope ?? 'global',
    industryNotes: rule.industryNotes ?? '',
    isActive: env().NOMUS_REQUIRE_RULE_APPROVAL === 'true' ? false : true,
    signature,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  }).run();

  tx.insert(policyEvents).values({
    id: randomUUID(),
    eventType: 'policy.created',
    ruleId,
    payload: JSON.stringify({ ...rule, version: 1 }),
    payloadSignature: signature,
    sequence: ctx.nextSequence(),
    createdAt: ctx.now,
  }).run();
  return 'created';
}

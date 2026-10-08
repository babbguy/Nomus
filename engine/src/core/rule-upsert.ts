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
import { canonicalJSON } from './policy-compiler.js';
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

export type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'skipped_locked';

/** Key-order-independent serialisation for comparing JSON values. */
const canon = (value: unknown): string => canonicalJSON({ value });

/** Stored JSON column -> value, tolerating legacy non-JSON text. */
function parseStored(value: string | null): unknown {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

/**
 * True when re-extraction produced exactly the stored rule. Re-processing an
 * unchanged document used to bump every rule's version, re-sign it, emit a
 * policy.updated event to every subscriber, move the corpus state hash and
 * create a duplicate "Regulation Change" radar signal.
 */
function sameAsStored(existing: typeof policyRules.$inferSelect, rule: ExtractedRule): boolean {
  return existing.jurisdiction === rule.jurisdiction
    && existing.category === rule.category
    && canon(parseStored(existing.conditions)) === canon(rule.conditions)
    && existing.effect === rule.effect
    && existing.severity === rule.severity
    && existing.humanSummary === rule.humanSummary
    && existing.legalReference === rule.legalReference
    && existing.effectiveDate === rule.effectiveDate
    && (existing.expiresAt ?? null) === (rule.expiresAt ?? null)
    && canon(parseStored(existing.industries) ?? ['all']) === canon(rule.industries ?? ['all'])
    && (existing.industryScope ?? 'global') === (rule.industryScope ?? 'global')
    && (existing.industryNotes ?? '') === (rule.industryNotes ?? '');
}

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

  if (existing && sameAsStored(existing, rule)) return 'unchanged';

  if (existing) {
    const newVersion = existing.version + 1;
    const signature = signRule({ ...rule, version: newVersion });
    tx.update(policyRules).set({
      version: newVersion,
      // Every signed field is stored: jurisdiction and category were signed
      // from the new extraction but never written, so a re-extraction that
      // changed the category left a rule whose signature no longer verified.
      jurisdiction: rule.jurisdiction,
      category: rule.category,
      conditions: JSON.stringify(rule.conditions),
      // Extracted rules carry effect/severity as free strings; the DB column
      // constrains them to the policy enums (validated upstream).
      effect: rule.effect as PolicyEffect,
      severity: rule.severity as PolicySeverity,
      humanSummary: rule.humanSummary,
      legalReference: rule.legalReference,
      effectiveDate: rule.effectiveDate,
      expiresAt: rule.expiresAt ?? null,
      industries: JSON.stringify(rule.industries ?? ['all']),
      industryScope: rule.industryScope ?? 'global',
      industryNotes: rule.industryNotes ?? '',
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

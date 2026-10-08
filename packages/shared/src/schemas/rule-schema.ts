import { z } from 'zod';
import {
  policyCategorySchema,
  policyEffectSchema,
  policySeveritySchema,
} from './policy-schema.js';

/** Rule keys are lowercase, dot-separated identifiers, e.g. `acme.art5.transparency`. */
export const RULE_KEY_PATTERN = /^[a-z][a-z0-9_.]{2,127}$/;

/** Jurisdiction codes are free-form but constrained: `EU`, `US-CA`, `JP`, ... */
export const JURISDICTION_CODE_PATTERN = /^[A-Z0-9-]{1,16}$/;

/**
 * A jurisdiction code. Trimmed and upper-cased before validation so `us-ca`
 * and `US-CA` are the same code (evaluation matches the stored string exactly).
 */
export const jurisdictionCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(JURISDICTION_CODE_PATTERN, 'Jurisdiction must be 1-16 characters of A-Z, 0-9 or "-"');

/**
 * Conditions of a hand-written rule. Evaluation compares each value to the
 * same-named key of the action context with strict string equality, and
 * ignores empty values, so every value must be a non-empty string.
 */
export const manualRuleConditionsSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Condition keys must be identifiers'),
    z.string().trim().min(1, 'Condition values must be non-empty strings').max(256),
  )
  .refine((v) => Object.keys(v).length > 0, { message: 'Conditions must have at least one key' })
  .refine((v) => Object.keys(v).length <= 20, { message: 'Conditions may have at most 20 keys' });

const dateOrDateTime = z.union([z.string().date(), z.string().datetime({ offset: true })]);

export const ruleIndustryScopeSchema = z.enum(['global', 'sector_specific', 'subsector_specific']);

const industriesSchema = z
  .array(z.string().trim().min(1).max(64))
  .min(1, 'At least one industry is required (use "all" for every industry)')
  .max(50);

const ruleContentShape = {
  jurisdiction: jurisdictionCodeSchema,
  category: policyCategorySchema,
  conditions: manualRuleConditionsSchema,
  effect: policyEffectSchema,
  severity: policySeveritySchema,
  humanSummary: z.string().trim().min(10).max(2000),
  legalReference: z.string().trim().min(3).max(500),
  effectiveDate: dateOrDateTime,
  expiresAt: dateOrDateTime.nullable(),
  industries: industriesSchema,
  industryScope: ruleIndustryScopeSchema,
  industryNotes: z.string().max(2000),
};

function expiresAfterEffective(v: { effectiveDate?: string; expiresAt?: string | null }): boolean {
  if (!v.effectiveDate || !v.expiresAt) return true;
  return Date.parse(v.expiresAt) > Date.parse(v.effectiveDate);
}

/** Body of `POST /api/v1/admin/rules`. */
export const createRuleSchema = z
  .object({
    sourceId: z.string().min(1),
    ruleKey: z
      .string()
      .regex(RULE_KEY_PATTERN, 'Rule key must be 3-128 chars: lowercase letters, digits, "_" or ".", starting with a letter'),
    jurisdiction: ruleContentShape.jurisdiction.optional(),
    category: ruleContentShape.category,
    conditions: ruleContentShape.conditions,
    effect: ruleContentShape.effect,
    severity: ruleContentShape.severity,
    humanSummary: ruleContentShape.humanSummary,
    legalReference: ruleContentShape.legalReference,
    effectiveDate: ruleContentShape.effectiveDate,
    expiresAt: ruleContentShape.expiresAt.optional(),
    industries: ruleContentShape.industries.default(['all']),
    industryScope: ruleContentShape.industryScope.default('global'),
    industryNotes: ruleContentShape.industryNotes.default(''),
  })
  .strict()
  .refine(expiresAfterEffective, { message: 'expiresAt must be after effectiveDate', path: ['expiresAt'] });

/**
 * Body of `PATCH /api/v1/admin/rules/:id`. Every content field is optional.
 * `locked: false` alone hands the rule back to the extraction pipeline.
 */
export const updateRuleSchema = z
  .object({
    jurisdiction: ruleContentShape.jurisdiction.optional(),
    category: ruleContentShape.category.optional(),
    conditions: ruleContentShape.conditions.optional(),
    effect: ruleContentShape.effect.optional(),
    severity: ruleContentShape.severity.optional(),
    humanSummary: ruleContentShape.humanSummary.optional(),
    legalReference: ruleContentShape.legalReference.optional(),
    effectiveDate: ruleContentShape.effectiveDate.optional(),
    expiresAt: ruleContentShape.expiresAt.optional(),
    industries: ruleContentShape.industries.optional(),
    industryScope: ruleContentShape.industryScope.optional(),
    industryNotes: ruleContentShape.industryNotes.optional(),
    locked: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })
  .refine(
    (v) => v.locked !== false || Object.keys(v).length === 1,
    { message: '"locked": false must be sent on its own', path: ['locked'] },
  )
  .refine(expiresAfterEffective, { message: 'expiresAt must be after effectiveDate', path: ['expiresAt'] });

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;

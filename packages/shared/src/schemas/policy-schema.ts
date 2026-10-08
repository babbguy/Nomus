import { z } from 'zod';

export const policyConditionsSchema = z.record(z.string().optional()).refine(
  (val) => Object.keys(val).length > 0,
  { message: 'Conditions must have at least one key' },
);

export const policyEffectSchema = z.enum([
  'deny',
  'allow_with_audit',
  'require_disclosure',
  'flag',
]);

export const policySeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
]);

export const policyCategorySchema = z.enum([
  'data_governance',
  'transparency',
  'risk_assessment',
  'human_oversight',
  'accountability',
  'fairness',
  'privacy',
  'safety',
  'security',
  'intellectual_property',
]);

/** Schema for LLM-generated policy rules (Step 3 output validation) */
export const llmPolicyOutputSchema = z.object({
  ruleKey: z.string().regex(/^[a-z][a-z0-9_.]+$/, 'Rule key must be dot-separated lowercase'),
  jurisdiction: z.string().min(2),
  category: policyCategorySchema,
  conditions: policyConditionsSchema,
  effect: policyEffectSchema,
  severity: policySeveritySchema,
  humanSummary: z.string().min(10).max(500),
  legalReference: z.string().min(3),
  effectiveDate: z.string().datetime({ offset: true }).or(z.string().date()),
  expiresAt: z.union([
    z.string().datetime({ offset: true }),
    z.string().date(),
    z.null(),
    z.literal(''),
    z.string(),
  ]).transform((val) => {
    // Coerce non-date strings to null (LLMs return "N/A", "none", "TBD", etc.)
    if (!val || val === 'null' || val === 'N/A' || val === 'none' || val === 'TBD' || val.length < 8) return null;
    // Validate it's actually a date
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : val;
  }).optional(),
});

export const llmPolicyArraySchema = z.array(llmPolicyOutputSchema).min(1);

/** Schema for the classifier (Step 2) output */
export const llmClassifierOutputSchema = z.object({
  classification: z.enum(['material', 'typo', 'formatting']),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(5).max(300),
});

/** Schema for evaluate request body */
export const evaluateRequestSchema = z.object({
  action: z.string().min(1),
  jurisdiction: z.string().min(2),
  context: policyConditionsSchema,
});

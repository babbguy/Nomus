import { z } from 'zod';

/**
 * The approval quorum configuration (design spec §4.1), mirrored from
 * engine/src/cpg/quorum/schema.ts for the quorum page's form validation and
 * for parsing GET /cpg/quorum. The dashboard checks a draft with exactly the
 * rules the engine applies, so a person sees every problem before saving;
 * the engine still validates every PUT. A test in
 * engine/src/server/dashboard-api-contract.test.ts runs both schemas over the
 * same accept and reject cases, so they cannot drift apart.
 *
 * Two rules are fixed by the brief and cannot be configured here either:
 * bulk decisions are never allowed on the prohibited tier, and there is no
 * setting that lets anyone approve their own proposal.
 *
 * This module imports only zod, so the engine's contract test can load it.
 */

const uuid = z.string().uuid();
const isoDate = z.string().datetime();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const scopeRuleSchema = z.object({
  allowed: z.literal(true),
  approvals: z.number().int().min(1).max(10),
  boardCoverage: z.enum(['all_owning', 'any_owning']),
  extraBoardIds: z.array(uuid).max(10).default([]),
  requiredPermission: z.enum(['exception.approve']).nullable().default(null),
  maxExpiryDays: z.number().int().min(1).max(3650),
  defaultExpiryDays: z.number().int().min(1).max(3650),
}).strict().refine((r) => r.defaultExpiryDays <= r.maxExpiryDays, {
  message: 'defaultExpiryDays must be <= maxExpiryDays',
});
const disallowed = z.object({ allowed: z.literal(false) }).strict();
const scopeSlot = z.union([scopeRuleSchema, disallowed]);

const reviewTier = z.object({ snippet: scopeSlot, bulk: scopeSlot, standing: scopeSlot }).strict();
const prohibitedTier = z.object({ snippet: scopeSlot, bulk: disallowed, standing: scopeSlot }).strict();
const override = z.object({ snippet: scopeSlot.optional(), bulk: scopeSlot.optional(), standing: scopeSlot.optional() }).strict();

export const quorumConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tiers: z.object({
    advisory: z.object({ blocking: z.literal(false) }).strict(),
    'review-required': reviewTier,
    prohibited: prohibitedTier,
  }).strict(),
  policyOverrides: z.record(uuid, override).default({}),
  policyApproval: z.object({ approvals: z.number().int().min(1).max(5) }).strict(),
  standingExceptions: z.object({
    maxExpiryDays: z.number().int().min(1).max(365),
    defaultExpiryDays: z.number().int().min(1).max(365),
    allowOrgWideRepoPatterns: z.boolean(),
  }).strict(),
  gracePeriod: z.object({
    newPolicyDefaultDays: z.number().int().min(0).max(365),
    newVersionDefaultDays: z.number().int().min(0).max(365),
  }).strict(),
  proposalLapseDays: z.number().int().min(1).max(90),
}).strict().superRefine((cfg, ctx) => {
  for (const tier of ['review-required', 'prohibited'] as const) {
    const s = cfg.tiers[tier].standing;
    if (s.allowed && s.maxExpiryDays > cfg.standingExceptions.maxExpiryDays) {
      ctx.addIssue({ code: 'custom', path: ['tiers', tier, 'standing', 'maxExpiryDays'], message: 'exceeds standingExceptions.maxExpiryDays' });
    }
  }
  if (cfg.standingExceptions.defaultExpiryDays > cfg.standingExceptions.maxExpiryDays) {
    ctx.addIssue({ code: 'custom', path: ['standingExceptions', 'defaultExpiryDays'], message: 'must be <= maxExpiryDays' });
  }
});

export const quorumVersionSchema = z.object({
  version: z.number().int().min(1),
  config: quorumConfigSchema,
  configHash: sha256Hex,
  changeNote: z.string(),
  createdAt: isoDate,
  createdBy: z.string(),
  signature: z.string().min(1),
}).strict();

export const quorumVersionSummarySchema = z.object({
  version: z.number().int().min(1),
  configHash: sha256Hex,
  changeNote: z.string(),
  createdAt: isoDate,
  createdBy: z.string(),
}).strict();

export type QuorumConfig = z.infer<typeof quorumConfigSchema>;
export type ScopeRule = z.infer<typeof scopeRuleSchema>;
export type ScopeSlot = z.infer<typeof scopeSlot>;
export type QuorumVersion = z.infer<typeof quorumVersionSchema>;
export type QuorumVersionSummary = z.infer<typeof quorumVersionSummarySchema>;
export type QuorumScope = 'snippet' | 'bulk' | 'standing';
export const QUORUM_SCOPES: readonly QuorumScope[] = ['snippet', 'bulk', 'standing'];

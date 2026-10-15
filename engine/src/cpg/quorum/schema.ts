import { z } from 'zod';

/**
 * The approval quorum configuration (design spec §4.1). Versioned and signed
 * per org (cpg_quorum_config_versions); every decision records the version
 * that applied. Admins edit it in the app; nothing here is hard-coded policy
 * except what the brief fixes:
 *
 * - advisory findings never block and need no review;
 * - bulk decisions are never allowed on the prohibited tier;
 * - there is deliberately no setting that permits self-approval.
 */

export const TIERS = ['advisory', 'review-required', 'prohibited'] as const;
const uuid = z.string().uuid();

const scopeRule = z.object({
  allowed: z.literal(true),
  approvals: z.number().int().min(1).max(10),
  // 'all_owning' = >=1 approving vote from a member of EACH required board.
  // 'any_owning' = >=1 approving vote from a member of ANY required board.
  boardCoverage: z.enum(['all_owning', 'any_owning']),
  extraBoardIds: z.array(uuid).max(10).default([]),
  // When set, at least one approving voter must hold this permission (effective on the repo).
  requiredPermission: z.enum(['exception.approve']).nullable().default(null),
  maxExpiryDays: z.number().int().min(1).max(3650),
  defaultExpiryDays: z.number().int().min(1).max(3650),
}).strict().refine((r) => r.defaultExpiryDays <= r.maxExpiryDays, {
  message: 'defaultExpiryDays must be <= maxExpiryDays',
});
const disallowed = z.object({ allowed: z.literal(false) }).strict();
const scopeSlot = z.union([scopeRule, disallowed]);

const reviewTier = z.object({ snippet: scopeSlot, bulk: scopeSlot, standing: scopeSlot }).strict();
const prohibitedTier = z.object({
  snippet: scopeSlot,
  bulk: disallowed, // brief §3: bulk is never allowed on prohibited; not configurable
  standing: scopeSlot,
}).strict();

const override = z.object({
  snippet: scopeSlot.optional(),
  bulk: scopeSlot.optional(), // write-time check: cannot enable bulk for a prohibited policy
  standing: scopeSlot.optional(),
}).strict();

export const quorumConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tiers: z.object({
    // advisory is never blocking and needs no review: fixed by brief §4.5 / §5
    advisory: z.object({ blocking: z.literal(false) }).strict(),
    'review-required': reviewTier,
    prohibited: prohibitedTier,
  }).strict(),
  policyOverrides: z.record(uuid /* cpg_policies.id */, override).default({}),
  policyApproval: z.object({
    approvals: z.number().int().min(1).max(5),
    // there is deliberately no field for author self-approval: it is always forbidden
  }).strict(),
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
      ctx.addIssue({
        code: 'custom',
        path: ['tiers', tier, 'standing', 'maxExpiryDays'],
        message: 'exceeds standingExceptions.maxExpiryDays',
      });
    }
  }
  if (cfg.standingExceptions.defaultExpiryDays > cfg.standingExceptions.maxExpiryDays) {
    ctx.addIssue({
      code: 'custom',
      path: ['standingExceptions', 'defaultExpiryDays'],
      message: 'must be <= maxExpiryDays',
    });
  }
});
export type QuorumConfig = z.infer<typeof quorumConfigSchema>;

/** Version 1 of every org (§4.2), written by `system:seed`. Brief §5 defaults. */
export const SEED_QUORUM_CONFIG: QuorumConfig = quorumConfigSchema.parse({
  schemaVersion: 1,
  tiers: {
    advisory: { blocking: false },
    'review-required': {
      snippet: { allowed: true, approvals: 1, boardCoverage: 'any_owning', extraBoardIds: [], requiredPermission: null, maxExpiryDays: 180, defaultExpiryDays: 90 },
      bulk: { allowed: true, approvals: 1, boardCoverage: 'any_owning', extraBoardIds: [], requiredPermission: null, maxExpiryDays: 180, defaultExpiryDays: 90 },
      standing: { allowed: true, approvals: 1, boardCoverage: 'any_owning', extraBoardIds: [], requiredPermission: 'exception.approve', maxExpiryDays: 90, defaultExpiryDays: 30 },
    },
    prohibited: {
      snippet: { allowed: true, approvals: 2, boardCoverage: 'all_owning', extraBoardIds: [], requiredPermission: null, maxExpiryDays: 90, defaultExpiryDays: 30 },
      bulk: { allowed: false },
      standing: { allowed: true, approvals: 2, boardCoverage: 'all_owning', extraBoardIds: [], requiredPermission: 'exception.approve', maxExpiryDays: 90, defaultExpiryDays: 30 },
    },
  },
  policyOverrides: {},
  policyApproval: { approvals: 1 },
  standingExceptions: { maxExpiryDays: 90, defaultExpiryDays: 30, allowOrgWideRepoPatterns: false },
  gracePeriod: { newPolicyDefaultDays: 14, newVersionDefaultDays: 0 },
  proposalLapseDays: 30,
});

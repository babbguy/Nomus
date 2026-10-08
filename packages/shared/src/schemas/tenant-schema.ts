import { z } from 'zod';

export const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens').min(2).max(50),
});

export const createApiKeySchema = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.enum(['read:policies', 'stream', 'evaluate', 'admin'])).min(1),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/** Scopes a non-admin user may grant to keys they create for their own org. */
export const SELF_SERVICE_KEY_SCOPES = ['read:policies', 'stream', 'evaluate'] as const;

/** Self-service key creation: same shape as createApiKeySchema, minus the admin scope. */
export const createOrgApiKeySchema = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.enum(SELF_SERVICE_KEY_SCOPES)).min(1),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

/**
 * Profile fields a member may edit on their own organization. Strict: name,
 * slug, isActive and any other platform-level field are rejected, not ignored.
 */
export const updateOrgProfileSchema = z.object({
  industry: z.string().trim().max(100).nullable().optional(),
  subIndustry: z.string().trim().max(100).nullable().optional(),
  jurisdictionAccess: z.array(z.string().min(1).max(20)).max(100).optional(),
  showOrgOnPublicVerify: z.boolean().optional(),
}).strict();

export const feedbackSchema = z.object({
  ruleId: z.string().uuid(),
  feedbackType: z.enum(['false_positive', 'false_negative', 'inaccurate', 'helpful']),
  description: z.string().max(1000).optional(),
});

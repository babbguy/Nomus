import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb, type Db } from '../../../db/client.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { cpgOrgSettings } from '../../../db/schema-cpg.js';
import { isLlmProviderConfigured } from '../../../llm/provider.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { appendAuditEvent } from '../../../cpg/audit/log.js';
import { invalidateCorporateBundle } from '../../../cpg/bundle/build.js';
import { cpgSettingsResponseSchema, patchSettingsRequestSchema, type CpgSettingsResponse } from '../../../cpg/contracts.js';
import { notFound } from '../../../cpg/errors.js';
import { actorFrom, auditActor, cpgAuth, handle, parseBody } from './helpers.js';

/** E15 GET and E16 PATCH /api/v1/cpg/settings. */
export const cpgSettingsRoutes = new Hono<AppEnv>();

function loadSettings(db: Db, orgId: string): CpgSettingsResponse {
  const s = getOrgSettings(db, orgId);
  if (!s) throw notFound('Settings');
  return cpgSettingsResponseSchema.parse({
    orgId: s.orgId,
    enabled: s.enabled,
    reviewerContextLlm: s.reviewerContextLlm,
    llmProviderConfigured: isLlmProviderConfigured('translator'),
    rbacMigratedAt: s.rbacMigratedAt,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  });
}

cpgSettingsRoutes.get('/', ...cpgAuth('policy.read', { scope: 'read:policies', allowUserKey: true }),
  handle((c) => c.json(loadSettings(getDb(), actorFrom(c).orgId))));

cpgSettingsRoutes.patch('/', ...cpgAuth('org.settings.manage'),
  handle(async (c) => {
    const body = await parseBody(c, patchSettingsRequestSchema);
    const db = getDb();
    const orgId = actorFrom(c).orgId;
    const actor = auditActor(c);
    const enabledChanged = rawSqlite(db).transaction(() => {
      const before = getOrgSettings(db, orgId);
      if (!before) throw notFound('Settings');
      const after = {
        enabled: body.enabled ?? before.enabled,
        reviewerContextLlm: body.reviewerContextLlm ?? before.reviewerContextLlm,
      };
      if (after.enabled === before.enabled && after.reviewerContextLlm === before.reviewerContextLlm) return false;
      db.update(cpgOrgSettings)
        .set({ ...after, updatedBy: actor, updatedAt: new Date().toISOString() })
        .where(eq(cpgOrgSettings.orgId, orgId))
        .run();
      appendAuditEvent(db, {
        orgId, actor, action: 'settings.updated', targetType: 'settings', targetId: orgId,
        payload: { before: { enabled: before.enabled, reviewerContextLlm: before.reviewerContextLlm }, after },
      });
      return after.enabled !== before.enabled;
    })();
    // The bundle carries (and signs) the enabled flag.
    if (enabledChanged) invalidateCorporateBundle(orgId, 'settings_changed');
    return c.json(loadSettings(db, orgId));
  }));

import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { users } from '../../../db/schema.js';
import { cpgRoles } from '../../../db/schema-cpg.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { summarizePermissions } from '../../../cpg/rbac/can.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { boardsOfUser } from '../../../cpg/boards/service.js';
import { meResponseSchema } from '../../../cpg/contracts.js';
import { notFound } from '../../../cpg/errors.js';
import { actorFrom, handle } from './helpers.js';

/**
 * E1 GET /api/v1/cpg/me: who the caller is in CPG terms. Sessions and
 * user-bound keys; any user, including a platform admin (who gets 200 with
 * no permissions, so the dashboard never sees a 4xx).
 */
export const cpgMeRoutes = new Hono<AppEnv>();

/**
 * The distinct roles behind the caller's effective grants (active grants of
 * unarchived roles, at any scope), sorted by key. The dashboard's user card
 * shows the most privileged one.
 */
function rolesOf(db: ReturnType<typeof getDb>, roleIds: string[]): Array<{ id: string; key: string; name: string; isSystem: boolean }> {
  const ids = [...new Set(roleIds)];
  if (ids.length === 0) return [];
  return db.select({ id: cpgRoles.id, key: cpgRoles.key, name: cpgRoles.name, isSystem: cpgRoles.isSystem })
    .from(cpgRoles).where(inArray(cpgRoles.id, ids)).all()
    .sort((a, b) => a.key.localeCompare(b.key));
}

cpgMeRoutes.get('/', requireSessionOrApiKey(), rateLimit(), requireCpgPermission(null, { allowUserKey: true }), handle((c) => {
  const db = getDb();
  const actor = actorFrom(c);
  const user = db.select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users).where(eq(users.id, actor.userId)).get();
  if (!user) throw notFound('User');
  const body = meResponseSchema.parse({
    user: { id: user.id, name: user.name, email: user.email },
    orgId: actor.orgId,
    cpgEnabled: getOrgSettings(db, actor.orgId)?.enabled ?? false,
    isPlatformAdmin: user.role === 'platform_admin',
    permissions: summarizePermissions(actor.grants),
    boards: boardsOfUser(db, actor.orgId, actor.userId),
    roles: rolesOf(db, actor.grants.map((g) => g.roleId)),
    identity: actor.identity,
  });
  return c.json(body);
}));

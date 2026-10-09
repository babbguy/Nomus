import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { users } from '../../../db/schema.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { summarizePermissions } from '../../../cpg/rbac/can.js';
import { getOrgSettings } from '../../../cpg/rbac/seed.js';
import { meResponseSchema } from '../../../cpg/contracts.js';
import { notFound } from '../../../cpg/errors.js';
import { actorFrom, handle } from './helpers.js';

/**
 * E1 GET /api/v1/cpg/me: who the caller is in CPG terms. Sessions and
 * user-bound keys; any user, including a platform admin (who gets 200 with
 * no permissions, so the dashboard never sees a 4xx).
 */
export const cpgMeRoutes = new Hono<AppEnv>();

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
    boards: [],
    identity: actor.identity,
  });
  return c.json(body);
}));

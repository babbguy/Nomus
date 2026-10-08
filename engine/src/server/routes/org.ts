import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { organizations, users } from '../../db/schema.js';
import { createOrgApiKeySchema, updateOrgProfileSchema, JURISDICTIONS } from '@nomus/shared';
import { requireSession } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../../tenant/api-keys.js';
import { actorOf, safeJson } from '../utils.js';
import { logger } from '../../logger.js';

/**
 * Self-service routes for the signed-in user's own organization. Every handler
 * is scoped by the session's orgId — there is no org id in any path, so a
 * caller cannot address another organization. Browser sessions only: API keys
 * cannot be used to mint more API keys.
 */
export const orgRoutes = new Hono<AppEnv>();

orgRoutes.use('*', requireSession());
orgRoutes.use('*', rateLimit());

function loadOrg(orgId: string) {
  const org = getDb().select().from(organizations).where(eq(organizations.id, orgId)).get();
  if (!org) return null;
  let jurisdictionAccess: string[];
  try {
    const parsed = JSON.parse(org.jurisdictionAccess);
    jurisdictionAccess = Array.isArray(parsed) ? parsed : [];
  } catch {
    jurisdictionAccess = [];
  }
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    industry: org.industry,
    subIndustry: org.subIndustry,
    jurisdictionAccess,
    showOrgOnPublicVerify: org.showOrgOnPublicVerify,
    createdAt: org.createdAt,
    updatedAt: org.updatedAt,
  };
}

// The caller's organization
orgRoutes.get('/', (c) => {
  const org = loadOrg(c.get('orgId')!);
  if (!org) return c.json({ error: 'Organization not found' }, 404);
  return c.json(org);
});

// Update self-manageable profile fields
orgRoutes.patch('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = updateOrgProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const input = parsed.data;
  const updates: Record<string, unknown> = {};
  if (input.industry !== undefined) updates.industry = input.industry || null;
  if (input.subIndustry !== undefined) updates.subIndustry = input.subIndustry || null;
  if (input.showOrgOnPublicVerify !== undefined) updates.showOrgOnPublicVerify = input.showOrgOnPublicVerify;
  if (input.jurisdictionAccess !== undefined) {
    const unknown = input.jurisdictionAccess.filter((j) => !(j in JURISDICTIONS));
    if (unknown.length > 0) {
      return c.json({ error: `Unknown jurisdiction code(s): ${unknown.join(', ')}` }, 400);
    }
    updates.jurisdictionAccess = JSON.stringify([...new Set(input.jurisdictionAccess)]);
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No updatable fields provided' }, 400);
  }
  updates.updatedAt = new Date().toISOString();

  const orgId = c.get('orgId')!;
  const result = getDb().update(organizations).set(updates).where(eq(organizations.id, orgId)).run();
  if (result.changes === 0) return c.json({ error: 'Organization not found' }, 404);

  logger.info({ orgId, fields: Object.keys(updates).filter((k) => k !== 'updatedAt'), actor: actorOf(c) }, 'Organization profile updated');
  return c.json(loadOrg(orgId));
});

// API keys for the caller's org
orgRoutes.get('/api-keys', (c) => {
  const keys = listApiKeys(c.get('orgId')!);
  return c.json({ count: keys.length, keys });
});

orgRoutes.post('/api-keys', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);

  // Called out explicitly so the caller gets a 403 rather than a generic 400
  const requested = (body as { scopes?: unknown } | null)?.scopes;
  if (Array.isArray(requested) && requested.includes('admin')) {
    return c.json({ error: 'The admin scope cannot be granted to self-service keys' }, 403);
  }

  const parsed = createOrgApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const orgId = c.get('orgId')!;
  const result = createApiKey(orgId, parsed.data);
  if (!result.ok) return c.json({ error: result.error }, 400);

  logger.info({ orgId, keyId: result.id, scopes: result.scopes, actor: actorOf(c) }, 'API key created');

  // Return the raw key ONCE — it can never be retrieved again
  return c.json({
    id: result.id,
    key: result.key,
    prefix: result.prefix,
    label: result.label,
    scopes: result.scopes,
    rateLimitRpm: result.rateLimitRpm,
    message: 'Store this key securely — it cannot be retrieved again.',
  }, 201);
});

orgRoutes.delete('/api-keys/:keyId', (c) => {
  const orgId = c.get('orgId')!;
  const keyId = c.req.param('keyId');
  if (!revokeApiKey(orgId, keyId)) {
    return c.json({ error: 'API key not found' }, 404);
  }
  logger.info({ orgId, keyId, actor: actorOf(c) }, 'API key revoked');
  return c.json({ message: 'API key revoked' });
});

// Read-only member list (users are managed by platform administrators)
orgRoutes.get('/members', (c) => {
  const members = getDb().select({
    id: users.id,
    name: users.name,
    email: users.email,
    role: users.role,
    isActive: users.isActive,
    createdAt: users.createdAt,
  }).from(users)
    .where(eq(users.orgId, c.get('orgId')!))
    .orderBy(asc(users.createdAt))
    .all();
  return c.json({ count: members.length, members });
});

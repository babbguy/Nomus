import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { AppEnv } from '../app.js';
import { getDb } from '../../db/client.js';
import { organizations } from '../../db/schema.js';
import { createOrgSchema, createApiKeySchema } from '@nomus/shared';
import { createApiKey, listApiKeys, revokeApiKey } from '../../tenant/api-keys.js';
import { logger } from '../../logger.js';
import { requireSessionOrApiKey } from '../middleware/auth.js';
import { safeParseInt, safeJson, actorOf } from '../utils.js';

export const tenantRoutes = new Hono<AppEnv>();

// All tenant routes require admin scope
tenantRoutes.use('*', requireSessionOrApiKey('admin'));

// List all organizations
tenantRoutes.get('/', (c) => {
  const db = getDb();
  const limit = Math.min(safeParseInt(c.req.query('limit'), 100), 500);
  const offset = safeParseInt(c.req.query('offset'), 0);
  const orgs = db.select().from(organizations).limit(limit).offset(offset).all();
  return c.json({
    count: orgs.length,
    tenants: orgs.map((o) => {
      let jurisdictionAccess: unknown;
      try { jurisdictionAccess = JSON.parse(o.jurisdictionAccess); } catch { jurisdictionAccess = []; }
      return { ...o, jurisdictionAccess };
    }),
  });
});

// Create organization
tenantRoutes.post('/', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createOrgSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const { name, slug } = parsed.data;

  // Check slug uniqueness
  const existing = db.select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .get();

  if (existing) {
    return c.json({ error: 'Organization slug already exists' }, 409);
  }

  const now = new Date().toISOString();

  const org = {
    id: randomUUID(),
    name,
    slug,
    jurisdictionAccess: JSON.stringify([]),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(organizations).values(org).run();

  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
  }, 201);
});

// Get organization
tenantRoutes.get('/:id', (c) => {
  const db = getDb();
  const org = db.select()
    .from(organizations)
    .where(eq(organizations.id, c.req.param('id')))
    .get();

  if (!org) return c.json({ error: 'Organization not found' }, 404);

  return c.json({
    ...org,
    jurisdictionAccess: (() => { try { return JSON.parse(org.jurisdictionAccess); } catch { return []; } })(),
  });
});

// Update organization
tenantRoutes.patch('/:id', async (c) => {
  const db = getDb();
  const { data: rawBody, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const body = rawBody as Record<string, any>;
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };

  if (body.name) updates.name = body.name;
  if (body.jurisdictionAccess) updates.jurisdictionAccess = JSON.stringify(body.jurisdictionAccess);
  if (body.isActive !== undefined) updates.isActive = body.isActive;
  // Opt-in org name display on the public attestation verify endpoint
  if (body.showOrgOnPublicVerify !== undefined) updates.showOrgOnPublicVerify = !!body.showOrgOnPublicVerify;

  const result = db.update(organizations)
    .set(updates)
    .where(eq(organizations.id, c.req.param('id')))
    .run();

  if (result.changes === 0) return c.json({ error: 'Organization not found' }, 404);
  return c.json({ message: 'Organization updated' });
});

// List API keys for org
tenantRoutes.get('/:id/api-keys', (c) => {
  const keys = listApiKeys(c.req.param('id'));
  return c.json({ count: keys.length, keys });
});

// Generate API key for org
tenantRoutes.post('/:id/api-keys', async (c) => {
  const { data: body, error: jsonError } = await safeJson(c);
  if (jsonError) return c.json({ error: jsonError }, 400);
  const parsed = createApiKeySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid input', details: parsed.error.issues }, 400);
  }

  const db = getDb();
  const orgId = c.req.param('id');

  // Verify org exists
  const org = db.select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .get();

  if (!org) return c.json({ error: 'Organization not found' }, 404);

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

// Revoke API key
tenantRoutes.delete('/:id/api-keys/:keyId', (c) => {
  const orgId = c.req.param('id');
  const keyId = c.req.param('keyId');

  if (!revokeApiKey(orgId, keyId)) {
    return c.json({ error: 'API key not found' }, 404);
  }

  logger.info({ orgId, keyId, actor: actorOf(c) }, 'API key revoked');
  return c.json({ message: 'API key revoked' });
});

// Get org usage stats
tenantRoutes.get('/:id/usage', (c) => {
  const db = getDb();
  const orgId = c.req.param('id');
  const since = c.req.query('since') || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const stats = db.get<{ total_requests: number; avg_response_ms: number; error_count: number }>(
    sql`SELECT
      COUNT(*) as total_requests,
      AVG(response_ms) as avg_response_ms,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
    FROM usage_records
    WHERE org_id = ${orgId} AND recorded_at >= ${since}`,
  );

  return c.json({ orgId, since, stats });
});

import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { AppEnv } from '../../app.js';
import { getDb, type Db } from '../../../db/client.js';
import { users } from '../../../db/schema.js';
import { cpgDeliveryAttempts, cpgNotificationDeliveries } from '../../../db/schema-cpg.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { appendAuditEvent } from '../../../cpg/audit/log.js';
import { CpgError, notFound } from '../../../cpg/errors.js';
import {
  createIntegration, getIntegration, integrationCreateSchema, integrationPatchSchema, listIntegrations, patchIntegration, rotateSecret,
  rotateSecretSchema, serializeIntegration,
} from '../../../cpg/notify/integrations.js';
import { enqueueRetry, enqueueTest, type DeliveryRow } from '../../../cpg/notify/outbox.js';
import { attemptDelivery } from '../../../cpg/notify/worker.js';
import { actorFrom, auditActor, cpgAuth, handle, parseBody, parseQuery, pathParam, requireEither } from './helpers.js';

/**
 * E64 to E70 (design spec §9.2, §12): integrations and the delivery log.
 * Secrets are never returned except a new webhook secret, once.
 */
export const cpgIntegrationRoutes = new Hono<AppEnv>();

const manage = cpgAuth('integrations.manage');

const deliveryQuerySchema = z.object({
  integrationId: z.string().uuid().optional(),
  caseId: z.string().uuid().optional(),
  status: z.enum(['pending', 'delivered', 'failed', 'cancelled']).optional(),
  cursor: z.string().regex(/^[1-9][0-9]{0,15}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

function serializeDeliveries(db: Db, rows: readonly DeliveryRow[]) {
  const attempts = rows.length === 0 ? [] : db.select().from(cpgDeliveryAttempts)
    .where(inArray(cpgDeliveryAttempts.deliveryId, rows.map((r) => r.id))).orderBy(asc(cpgDeliveryAttempts.attempt)).all();
  return rows.map((r) => ({
    id: r.id, integrationId: r.integrationId, channel: r.channel, event: r.event, caseId: r.caseId, boardId: r.boardId,
    payload: JSON.parse(r.payload) as unknown, payloadSha256: r.payloadSha256, retryOf: r.retryOf, status: r.status,
    attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    attemptHistory: attempts.filter((a) => a.deliveryId === r.id).map(({ id: _id, deliveryId: _d, ...a }) => a),
  }));
}

// E64
cpgIntegrationRoutes.get('/integrations', ...manage, handle((c) => {
  return c.json({ items: listIntegrations(getDb(), actorFrom(c).orgId).map(serializeIntegration) });
}));

// E65: a webhook's signing secret is in this response and nowhere else, ever.
cpgIntegrationRoutes.post('/integrations', ...manage, handle(async (c) => {
  const body = await parseBody(c, integrationCreateSchema);
  const { row, secret } = createIntegration(getDb(), actorFrom(c).orgId, body, auditActor(c));
  return c.json({ integration: serializeIntegration(row), ...(secret ? { secret } : {}) }, 201);
}));

// E66
cpgIntegrationRoutes.patch('/integrations/:id', ...manage, handle(async (c) => {
  const body = await parseBody(c, integrationPatchSchema);
  return c.json(serializeIntegration(patchIntegration(getDb(), actorFrom(c).orgId, pathParam(c, 'id'), body, auditActor(c))));
}));

// E67
cpgIntegrationRoutes.post('/integrations/:id/rotate-secret', ...manage, handle(async (c) => {
  const body = await parseBody(c, rotateSecretSchema);
  const { row, secret } = rotateSecret(getDb(), actorFrom(c).orgId, pathParam(c, 'id'), body, auditActor(c));
  return c.json({ integration: serializeIntegration(row), ...(secret ? { secret } : {}) });
}));

// E68: an integration.test delivery, sent now (one attempt, at most 10 s); a retryable failure stays queued.
cpgIntegrationRoutes.post('/integrations/:id/test', ...manage, handle(async (c) => {
  await parseBody(c, z.object({}).strict());
  const db = getDb();
  const actor = actorFrom(c);
  const integration = getIntegration(db, actor.orgId, pathParam(c, 'id'));
  if (!integration.enabled) throw new CpgError(409, 'integration_disabled', 'Enable the integration before testing it');
  const email = db.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)).get()!.email;
  const delivery = await attemptDelivery(db, enqueueTest(db, integration, email));
  return c.json(serializeDeliveries(db, [delivery])[0], 201);
}));

// E69: integrations.manage or audit.read.
cpgIntegrationRoutes.get('/deliveries', ...cpgAuth(null), handle((c) => {
  const actor = actorFrom(c);
  requireEither(actor, 'integrations.manage', 'audit.read', 'audit.read');
  const q = parseQuery(c, deliveryQuerySchema);
  const db = getDb();
  const where: SQL[] = [eq(cpgNotificationDeliveries.orgId, actor.orgId)];
  if (q.integrationId) where.push(eq(cpgNotificationDeliveries.integrationId, q.integrationId));
  if (q.caseId) where.push(eq(cpgNotificationDeliveries.caseId, q.caseId));
  if (q.status) where.push(eq(cpgNotificationDeliveries.status, q.status));
  if (q.cursor) where.push(lt(sql`rowid`, Number(q.cursor)));
  const rows = db.select({ row: cpgNotificationDeliveries, rowid: sql<number>`rowid` }).from(cpgNotificationDeliveries)
    .where(and(...where)).orderBy(desc(sql`rowid`)).limit(q.limit + 1).all();
  const page = rows.slice(0, q.limit);
  return c.json({
    items: serializeDeliveries(db, page.map((r) => r.row)),
    nextCursor: rows.length > q.limit ? String(page[page.length - 1].rowid) : null,
  });
}));

// E70: only a failed delivery; the retry is a new delivery that names it.
cpgIntegrationRoutes.post('/deliveries/:id/retry', ...manage, handle(async (c) => {
  await parseBody(c, z.object({}).strict());
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const failed = db.select().from(cpgNotificationDeliveries)
    .where(and(eq(cpgNotificationDeliveries.id, pathParam(c, 'id')), eq(cpgNotificationDeliveries.orgId, orgId))).get();
  if (!failed) throw notFound('Delivery');
  if (failed.status !== 'failed') throw new CpgError(409, 'delivery_not_failed', 'Only a failed delivery can be retried', { status: failed.status });
  const integration = getIntegration(db, orgId, failed.integrationId);
  if (!integration.enabled) throw new CpgError(409, 'integration_disabled', 'Enable the integration before retrying');
  const retry = rawSqlite(db).transaction(() => {
    const row = enqueueRetry(db, integration, failed);
    appendAuditEvent(db, { orgId, actor: auditActor(c), action: 'delivery.retried', targetType: 'delivery', targetId: failed.id, payload: { retryId: row.id } });
    return row;
  }).immediate();
  return c.json(serializeDeliveries(db, [retry])[0], 201);
}));

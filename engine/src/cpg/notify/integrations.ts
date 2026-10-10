import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { env } from '../../config/env.js';
import { encryptForStorage } from '../../core/crypto.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgBoards, cpgIntegrations } from '../../db/schema-cpg.js';
import { isSsrfSafe } from '../../server/utils/ssrf.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError, notFound } from '../errors.js';
import { CPG_EVENTS } from './summary.js';

/**
 * Integration configs (design spec §12.2, §12.5, E64 to E67). Secrets (the
 * Jira API token, the webhook HMAC secret) are stored with the engine's
 * encryptForStorage, never returned (only their last 4 characters) and
 * never written to the audit log. Every change is audited.
 */

export type IntegrationRow = typeof cpgIntegrations.$inferSelect;

const allowPrivateTargets = () => env().NOMUS_CPG_ALLOW_PRIVATE_TARGETS === 'true';

/** Why a Jira or webhook URL may not be used (null when it may). Checked on save and again before every send. */
export function targetProblem(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'invalid URL'; }
  if (allowPrivateTargets()) return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? null : `protocol ${parsed.protocol} not allowed`;
  if (parsed.protocol !== 'https:') return 'HTTPS is required';
  const safe = isSsrfSafe(url);
  return safe.ok ? null : safe.reason;
}

const targetUrl = z.string().url().max(2000).superRefine((u, ctx) => {
  const problem = targetProblem(u);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Target not allowed: ${problem}` });
});

const configSchemas = {
  email: z.object({
    includeBoardMembers: z.boolean().default(true),
    notifyDevelopers: z.boolean().default(true),
    extraRecipients: z.array(z.string().email()).max(50).default([]),
  }).strict(),
  jira: z.object({
    baseUrl: targetUrl.transform((u) => u.replace(/\/+$/, '')),
    accountEmail: z.string().email(),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/),
    issueType: z.string().min(1).max(50).default('Task'),
    labels: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,50}$/)).max(10).default(['nomus']),
  }).strict(),
  webhook: z.object({ url: targetUrl }).strict(),
};
export type EmailConfig = z.infer<typeof configSchemas.email>;
export type JiraConfig = z.infer<typeof configSchemas.jira>;
export type WebhookConfig = z.infer<typeof configSchemas.webhook>;

const base = {
  name: z.string().trim().min(1).max(100),
  boardIds: z.array(z.string().uuid()).max(50).default([]),
  events: z.array(z.enum(CPG_EVENTS)).min(1),
  enabled: z.boolean().default(true),
};

export const integrationCreateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), ...base, config: configSchemas.email }).strict(),
  z.object({ kind: z.literal('jira'), ...base, config: configSchemas.jira, apiToken: z.string().min(8).max(500) }).strict(),
  z.object({ kind: z.literal('webhook'), ...base, config: configSchemas.webhook }).strict(),
]);
type IntegrationCreate = z.infer<typeof integrationCreateSchema>;

export const integrationPatchSchema = z.object({
  name: base.name.optional(),
  boardIds: z.array(z.string().uuid()).max(50).optional(),
  events: base.events.optional(),
  enabled: z.boolean().optional(),
  /** The whole config of the integration's kind, validated against it. */
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const rotateSecretSchema = z.object({ apiToken: z.string().min(8).max(500).optional() }).strict();

const integrationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['email', 'jira', 'webhook']),
  name: z.string(),
  boardIds: z.array(z.string().uuid()),
  events: z.array(z.enum(CPG_EVENTS)),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  secretLast4: z.string().nullable(),
  createdBy: z.string(), createdAt: z.string().datetime(),
  updatedBy: z.string(), updatedAt: z.string().datetime(),
}).strict();
type Integration = z.infer<typeof integrationSchema>;

export function serializeIntegration(r: IntegrationRow): Integration {
  return integrationSchema.parse({
    id: r.id, kind: r.kind, name: r.name, boardIds: JSON.parse(r.boardIds), events: JSON.parse(r.events), config: JSON.parse(r.config),
    enabled: r.enabled, secretLast4: r.secretLast4, createdBy: r.createdBy, createdAt: r.createdAt, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
  });
}

export function listIntegrations(db: Db, orgId: string): IntegrationRow[] {
  return db.select().from(cpgIntegrations).where(eq(cpgIntegrations.orgId, orgId)).orderBy(asc(cpgIntegrations.createdAt), asc(cpgIntegrations.id)).all();
}

export function getIntegration(db: Db, orgId: string, id: string): IntegrationRow {
  const row = db.select().from(cpgIntegrations).where(and(eq(cpgIntegrations.id, id), eq(cpgIntegrations.orgId, orgId))).get();
  if (!row) throw notFound('Integration');
  return row;
}

/** A webhook signing secret: 32 random bytes, base64url, prefixed whsec_ (§12.3). */
const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
const sealed = (secret: string) => ({ secretEnc: encryptForStorage(secret), secretLast4: secret.slice(-4) });

function assertBoards(db: Db, orgId: string, boardIds: readonly string[]): void {
  if (boardIds.length === 0) return;
  const known = new Set(db.select({ id: cpgBoards.id }).from(cpgBoards)
    .where(and(eq(cpgBoards.orgId, orgId), inArray(cpgBoards.id, [...boardIds]))).all().map((b) => b.id));
  const unknown = boardIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new CpgError(422, 'unknown_board', 'A board does not exist in this organization', { boardIds: unknown });
}

/** What the audit log records of an integration: everything but the secret. */
const auditView = (r: Pick<IntegrationRow, 'kind' | 'name' | 'boardIds' | 'events' | 'config' | 'enabled'>) => ({
  kind: r.kind, name: r.name, boardIds: JSON.parse(r.boardIds), events: JSON.parse(r.events), config: JSON.parse(r.config), enabled: r.enabled,
});

/** E65. Returns the webhook secret exactly once. */
export function createIntegration(db: Db, orgId: string, input: IntegrationCreate, actor: string): { row: IntegrationRow; secret: string | null } {
  return rawSqlite(db).transaction(() => {
    assertBoards(db, orgId, input.boardIds);
    const now = new Date().toISOString();
    const secret = input.kind === 'webhook' ? newWebhookSecret() : null;
    const stored = input.kind === 'jira' ? sealed(input.apiToken) : secret ? sealed(secret) : { secretEnc: null, secretLast4: null };
    const row: IntegrationRow = {
      id: randomUUID(), orgId, kind: input.kind, name: input.name, boardIds: JSON.stringify([...new Set(input.boardIds)].sort()),
      events: JSON.stringify([...new Set(input.events)].sort()), config: JSON.stringify(input.config), ...stored,
      enabled: input.enabled, createdBy: actor, createdAt: now, updatedBy: actor, updatedAt: now,
    };
    db.insert(cpgIntegrations).values(row).run();
    appendAuditEvent(db, { orgId, actor, action: 'integration.created', targetType: 'integration', targetId: row.id, payload: auditView(row) });
    return { row, secret };
  }).immediate();
}

/** E66. */
export function patchIntegration(db: Db, orgId: string, id: string, patch: z.infer<typeof integrationPatchSchema>, actor: string): IntegrationRow {
  return rawSqlite(db).transaction(() => {
    const before = getIntegration(db, orgId, id);
    let config = before.config;
    if (patch.config !== undefined) {
      const parsed = configSchemas[before.kind].safeParse(patch.config);
      if (!parsed.success) throw new CpgError(400, 'invalid_input', 'Invalid input', parsed.error.issues.map((i) => ({ ...i, path: ['config', ...i.path] })));
      config = JSON.stringify(parsed.data);
    }
    if (patch.boardIds) assertBoards(db, orgId, patch.boardIds);
    const changes = {
      name: patch.name ?? before.name,
      boardIds: patch.boardIds ? JSON.stringify([...new Set(patch.boardIds)].sort()) : before.boardIds,
      events: patch.events ? JSON.stringify([...new Set(patch.events)].sort()) : before.events,
      enabled: patch.enabled ?? before.enabled,
      config,
    };
    const after = { ...before, ...changes, updatedBy: actor, updatedAt: new Date().toISOString() };
    if (JSON.stringify(auditView(after)) === JSON.stringify(auditView(before))) return before;
    db.update(cpgIntegrations).set({ ...changes, updatedBy: actor, updatedAt: after.updatedAt }).where(eq(cpgIntegrations.id, id)).run();
    appendAuditEvent(db, { orgId, actor, action: 'integration.updated', targetType: 'integration', targetId: id, payload: { before: auditView(before), after: auditView(after) } });
    return after;
  }).immediate();
}

/** E67: a new Jira token (given) or a new webhook secret (generated, returned once). */
export function rotateSecret(db: Db, orgId: string, id: string, input: z.infer<typeof rotateSecretSchema>, actor: string): { row: IntegrationRow; secret: string | null } {
  return rawSqlite(db).transaction(() => {
    const before = getIntegration(db, orgId, id);
    if (before.kind === 'email') throw new CpgError(409, 'no_secret', 'An email integration has no secret');
    if (before.kind === 'jira' && !input.apiToken) throw new CpgError(422, 'api_token_required', 'Send the new Jira API token as apiToken');
    if (before.kind === 'webhook' && input.apiToken) throw new CpgError(422, 'secret_generated', 'Webhook secrets are generated by Nomus; send {}');
    const secret = before.kind === 'webhook' ? newWebhookSecret() : null;
    const now = new Date().toISOString();
    const stored = sealed(secret ?? input.apiToken!);
    db.update(cpgIntegrations).set({ ...stored, updatedBy: actor, updatedAt: now }).where(eq(cpgIntegrations.id, id)).run();
    appendAuditEvent(db, { orgId, actor, action: 'integration.secret_rotated', targetType: 'integration', targetId: id, payload: { secretRotated: true } });
    return { row: { ...before, ...stored, updatedBy: actor, updatedAt: now }, secret };
  }).immediate();
}

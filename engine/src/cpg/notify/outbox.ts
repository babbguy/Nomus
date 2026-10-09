import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sha256Hex } from '@nomus/scanner/corporate';
import { rawSqlite } from '../../db/migrations/runner.js';
import { users } from '../../db/schema.js';
import { cpgIntegrations, cpgJustifications, cpgNotificationDeliveries, cpgPolicyVersions } from '../../db/schema-cpg.js';
import { logger } from '../../logger.js';
import { activeMembers } from '../boards/service.js';
import { caseLanes } from '../cases/lanes.js';
import type { CaseRow } from '../cases/service.js';
import type { ExpiryNotice } from '../decisions/sweep.js';
import { boardIdsOf } from '../policies/service.js';
import type { EmailConfig, IntegrationRow } from './integrations.js';
import { buildSummary, caseNotificationSummarySchema, type CaseNotificationSummary, type CpgEvent, type SummaryInput } from './summary.js';
import { kickNotificationWorker } from './worker.js';

/**
 * The transactional outbox (design spec §12.4). Domain code calls these
 * inside its own transaction, so a rolled-back change never notifies and a
 * committed one always has its deliveries. The worker is kicked with
 * setImmediate, which runs after the synchronous transaction has ended.
 *
 * A notification must never fail the user's action: if building one throws,
 * the error is logged at error level (visible, never silent) and the action
 * commits without it.
 */

type Db = BetterSQLite3Database<any>;
export type DeliveryRow = typeof cpgNotificationDeliveries.$inferSelect;

/** What a delivery stores and sends: the summary, plus the email recipients. */
export interface DeliveryPayload { summary: CaseNotificationSummary; recipients?: string[] }

/** Events that create or comment on the lane's Jira issue (§12.1); the others go to email and webhooks only. */
const JIRA_EVENTS: ReadonlySet<CpgEvent> = new Set(['case.review_requested', 'case.changes_requested', 'case.replied', 'decision.recorded', 'case.closed', 'integration.test']);
/** Events whose default email recipients are the case's developers rather than the board. */
const DEVELOPER_EVENTS: ReadonlySet<CpgEvent> = new Set(['case.changes_requested']);
/** Events that email nobody by default (§12.1); extra recipients still get them. */
const QUIET_EVENTS: ReadonlySet<CpgEvent> = new Set(['decision.recorded', 'case.closed']);

/**
 * A case-lane event, one notification per lane with a blocking finding.
 * `boardId` narrows it to one lane; `policyVersionId` to the lanes of the
 * boards that own that policy version.
 */
export function notifyCase(db: Db, c: CaseRow, event: CpgEvent, opts: { boardId?: string | null; policyVersionId?: string; decision?: SummaryInput['decision'] } = {}): void {
  guarded(db, event, () => {
    if (!hasIntegrations(db, c.orgId, event)) return;
    const owners = opts.policyVersionId === undefined ? null : owningBoards(db, opts.policyVersionId);
    const boards = new Set(caseLanes(db, c.orgId, c.id)
      .filter((l) => l.blocking > 0 && (opts.boardId == null || l.boardId === opts.boardId) && (owners === null || owners.includes(l.boardId)))
      .map((l) => l.boardId));
    // A case whose findings were all fixed has no lanes left; its close still reaches every board it notified.
    if (event === 'case.closed') {
      for (const r of db.selectDistinct({ boardId: cpgNotificationDeliveries.boardId }).from(cpgNotificationDeliveries)
        .where(eq(cpgNotificationDeliveries.caseId, c.id)).all()) if (r.boardId) boards.add(r.boardId);
    }
    const occurredAt = new Date().toISOString();
    for (const boardId of boards) enqueue(db, buildSummary(db, { event, orgId: c.orgId, case: c, boardId, decision: opts.decision, occurredAt }), c);
  });
}

/** The 5a.2 sweep hook: an approval or standing exception is about to expire, or has (§7.5). Routed to the policy's owning boards. */
export function notifyExpiry(db: Db, { decision: d, threshold }: ExpiryNotice): void {
  const event: CpgEvent = threshold === 'expired' ? 'exception.expired' : 'exception.expiring';
  guarded(db, event, () => {
    if (!hasIntegrations(db, d.orgId, event)) return;
    const decision = { id: d.id, scope: d.scope, outcome: d.outcome, expiresAt: d.expiresAt, findingCount: d.scope === 'standing' ? 0 : 1 };
    const occurredAt = new Date().toISOString();
    for (const boardId of owningBoards(db, d.policyVersionId)) {
      enqueue(db, buildSummary(db, { event, orgId: d.orgId, case: null, boardId, policyVersionIds: [d.policyVersionId], decision, occurredAt }), null);
    }
  });
}

/** E68: one integration.test delivery to `integration`, emailed to the caller and the extra recipients. */
export function enqueueTest(db: Db, integration: IntegrationRow, callerEmail: string): DeliveryRow {
  const summary = buildSummary(db, { event: 'integration.test', orgId: integration.orgId, case: null, boardId: null, occurredAt: new Date().toISOString() });
  const extra = integration.kind === 'email' ? (JSON.parse(integration.config) as EmailConfig).extraRecipients : [];
  return insertDelivery(db, integration, summary, null, { recipients: [...new Set([callerEmail, ...extra])].sort() }, null, false);
}

/** E70: a failed delivery is sent again as a new delivery; the failed one stays as it was. */
export function enqueueRetry(db: Db, integration: IntegrationRow, failed: DeliveryRow): DeliveryRow {
  const old = JSON.parse(failed.payload) as DeliveryPayload;
  const { deliveryId: _, ...summary } = old.summary;
  return insertDelivery(db, integration, summary, failed.caseId, { recipients: old.recipients }, failed.id, true);
}

// ─── Internals ─────────────────────────────────────────────────────────

/** Run `fn` in a savepoint: on failure none of its deliveries are written, and the caller's transaction goes on. */
function guarded(db: Db, event: CpgEvent, fn: () => void): void {
  try {
    rawSqlite(db).transaction(fn)();
  } catch (err) {
    logger.error({ err, event }, 'CPG notification could not be queued; the action itself completed');
  }
}

function owningBoards(db: Db, policyVersionId: string): string[] {
  const version = db.select({ owningBoardIds: cpgPolicyVersions.owningBoardIds }).from(cpgPolicyVersions).where(eq(cpgPolicyVersions.id, policyVersionId)).get();
  return version ? boardIdsOf(version) : [];
}

function enabledIntegrations(db: Db, orgId: string): IntegrationRow[] {
  return db.select().from(cpgIntegrations).where(and(eq(cpgIntegrations.orgId, orgId), eq(cpgIntegrations.enabled, true))).all();
}

const subscribed = (i: IntegrationRow, event: CpgEvent) => (JSON.parse(i.events) as string[]).includes(event);
const hasIntegrations = (db: Db, orgId: string, event: CpgEvent) => enabledIntegrations(db, orgId).some((i) => subscribed(i, event));

/** One delivery per integration that wants this event for this board. */
function enqueue(db: Db, summary: Omit<CaseNotificationSummary, 'deliveryId'>, c: CaseRow | null): void {
  for (const i of enabledIntegrations(db, summary.org.id)) {
    const boards = JSON.parse(i.boardIds) as string[];
    if (!subscribed(i, summary.event) || (boards.length > 0 && !boards.includes(summary.board?.id ?? ''))) continue;
    if (i.kind === 'jira' && (!JIRA_EVENTS.has(summary.event) || summary.case === null)) continue;
    let recipients: string[] | undefined;
    if (i.kind === 'email') {
      recipients = emailRecipients(db, JSON.parse(i.config) as EmailConfig, summary, c);
      if (recipients.length === 0) continue;
    }
    insertDelivery(db, i, summary, c?.id ?? null, { recipients }, null, true);
  }
}

function insertDelivery(db: Db, i: IntegrationRow, summary: Omit<CaseNotificationSummary, 'deliveryId'>, caseId: string | null,
  extra: { recipients?: string[] }, retryOf: string | null, due: boolean): DeliveryRow {
  const id = randomUUID();
  const now = new Date().toISOString();
  const payload: DeliveryPayload = { summary: caseNotificationSummarySchema.parse({ ...summary, deliveryId: id }), ...(i.kind === 'email' ? { recipients: extra.recipients ?? [] } : {}) };
  const text = JSON.stringify(payload);
  const row: DeliveryRow = {
    id, orgId: i.orgId, integrationId: i.id, channel: i.kind, event: summary.event, caseId, boardId: summary.board?.id ?? null,
    payload: text, payloadSha256: sha256Hex(text), retryOf, status: 'pending', attempts: 0,
    // A synchronous test send leases the row itself (the worker only takes due rows).
    nextAttemptAt: due ? now : new Date(Date.now() + 60_000).toISOString(), createdAt: now, updatedAt: now,
  };
  db.insert(cpgNotificationDeliveries).values(row).run();
  if (due) kickNotificationWorker();
  return row;
}

/** §12.1 default recipients, active users only, plus the configured extra addresses. */
function emailRecipients(db: Db, cfg: EmailConfig, s: Omit<CaseNotificationSummary, 'deliveryId'>, c: CaseRow | null): string[] {
  const userIds = new Set<string>();
  if (DEVELOPER_EVENTS.has(s.event)) {
    if (cfg.notifyDevelopers && c) {
      if (c.openedBy.startsWith('user:')) userIds.add(c.openedBy.slice(5));
      for (const j of db.selectDistinct({ id: cpgJustifications.authorUserId }).from(cpgJustifications).where(eq(cpgJustifications.caseId, c.id)).all()) userIds.add(j.id);
    }
  } else if (!QUIET_EVENTS.has(s.event) && cfg.includeBoardMembers && s.board) {
    for (const m of activeMembers(db, s.board.id)) userIds.add(m.userId);
  }
  const emails = userIds.size === 0 ? [] : db.select({ email: users.email }).from(users)
    .where(and(inArray(users.id, [...userIds]), eq(users.orgId, s.org.id), eq(users.isActive, true))).all().map((u) => u.email);
  return [...new Set([...emails, ...cfg.extraRecipients])].sort();
}

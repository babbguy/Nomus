import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { decryptFromStorage } from '../../core/crypto.js';
import { getDb } from '../../db/client.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgDeliveryAttempts, cpgIntegrationLinks, cpgIntegrations, cpgNotificationDeliveries } from '../../db/schema-cpg.js';
import { logger } from '../../logger.js';
import { getResendApiKey, sendEmailDetailed } from '../../services/notifications.js';
import { appendAuditEvent } from '../audit/log.js';
import { targetProblem, type IntegrationRow, type JiraConfig, type WebhookConfig } from './integrations.js';
import type { DeliveryPayload, DeliveryRow } from './outbox.js';
import { jiraLabel, renderEmail, renderJiraComment, renderJiraIssue, renderWebhook } from './render.js';
import type { CaseNotificationSummary } from './summary.js';

/**
 * The delivery worker (design spec §12.4). Due rows of the outbox are sent
 * one at a time behind a single-flight guard; every attempt is recorded, a
 * retryable failure is rescheduled on a fixed backoff that survives restarts
 * (the schedule lives in the database), and a permanent failure is logged at
 * error level and audited. Idle cost: one indexed SELECT every 15 s.
 */

type Db = BetterSQLite3Database<any>;

/** Delay before attempt n+1 after n attempts: +0, 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h (8 attempts, about 21 h). */
export const RETRY_SCHEDULE_MS = [0, 10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length;
const BATCH = 20;
const TICK_MS = 15_000;
const TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

export interface AttemptOutcome {
  httpStatus: number | null;
  error: string | null;
  excerpt: string | null;
  /** A configuration problem: retrying cannot help. */
  permanent?: boolean;
  retryAfterMs?: number | null;
}

/** delivered on success; retry on network errors, timeouts, 5xx, 408 and 429; anything else fails at once. */
export function classify(o: AttemptOutcome): 'delivered' | 'retry' | 'failed' {
  if (o.error === null) return 'delivered';
  if (o.permanent) return 'failed';
  const s = o.httpStatus;
  return s === null || s >= 500 || s === 408 || s === 429 ? 'retry' : 'failed';
}

/** When attempt `attemptsDone + 1` is due, honouring Retry-After up to 1 h. */
export function nextAttemptAt(attemptsDone: number, now: number, retryAfterMs?: number | null): string {
  const wait = Math.max(RETRY_SCHEDULE_MS[attemptsDone], Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
  return new Date(now + wait).toISOString();
}

// ─── Scheduling ────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;

export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runDueDeliveries(), TICK_MS);
  timer.unref();
  kickNotificationWorker();
}

export function stopNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run soon (after the current transaction has committed); a no-op unless the worker is started. */
export function kickNotificationWorker(): void {
  if (timer) setImmediate(() => void runDueDeliveries());
}

/** Send every due delivery, oldest first. Single-flight: a call while one runs makes that run go round again. */
export async function runDueDeliveries(db: Db = getDb()): Promise<number> {
  if (running) {
    again = true;
    return 0;
  }
  running = true;
  let sent = 0;
  try {
    let due: DeliveryRow[];
    do {
      again = false;
      due = db.select().from(cpgNotificationDeliveries)
        .where(and(eq(cpgNotificationDeliveries.status, 'pending'), lte(cpgNotificationDeliveries.nextAttemptAt, new Date().toISOString())))
        .orderBy(asc(cpgNotificationDeliveries.nextAttemptAt), asc(sql`rowid`)).limit(BATCH).all();
      for (const d of due) {
        await attemptDelivery(db, d);
        sent += 1;
      }
    } while (again || due.length === BATCH);
  } catch (err) {
    logger.error({ err }, 'CPG delivery worker failed');
  } finally {
    running = false;
  }
  return sent;
}

/** One attempt of a pending delivery: send, record the attempt, move the queue state on. */
export async function attemptDelivery(db: Db, d: DeliveryRow): Promise<DeliveryRow> {
  const integration = db.select().from(cpgIntegrations).where(eq(cpgIntegrations.id, d.integrationId)).get()!;
  if (!integration.enabled) {
    logger.warn({ deliveryId: d.id, integrationId: d.integrationId }, 'CPG delivery cancelled: the integration is disabled');
    return finish(db, d, { status: 'cancelled', attempts: d.attempts, nextAttemptAt: null });
  }
  const attempt = d.attempts + 1;
  const startedAt = new Date();
  let outcome: AttemptOutcome;
  try {
    outcome = await send(db, integration, JSON.parse(d.payload) as DeliveryPayload);
  } catch (err) {
    outcome = { httpStatus: null, error: (err as Error).message.slice(0, 500), excerpt: null };
  }
  const durationMs = Date.now() - startedAt.getTime();
  let verdict = classify(outcome);
  if (verdict === 'retry' && attempt >= MAX_ATTEMPTS) verdict = 'failed';
  const log = { deliveryId: d.id, integrationId: d.integrationId, channel: d.channel, event: d.event, attempt, httpStatus: outcome.httpStatus, error: outcome.error };

  return rawSqlite(db).transaction(() => {
    db.insert(cpgDeliveryAttempts).values({
      id: randomUUID(), deliveryId: d.id, attempt, startedAt: startedAt.toISOString(), durationMs,
      httpStatus: outcome.httpStatus, error: outcome.error?.slice(0, 500) ?? null, responseExcerpt: outcome.excerpt?.slice(0, 500) ?? null,
    }).run();
    if (verdict === 'delivered') {
      logger.info(log, 'CPG delivery sent');
      return finish(db, d, { status: 'delivered', attempts: attempt, nextAttemptAt: null });
    }
    if (verdict === 'retry') {
      logger.warn(log, 'CPG delivery attempt failed; it will be retried');
      return finish(db, d, { status: 'pending', attempts: attempt, nextAttemptAt: nextAttemptAt(attempt, Date.now(), outcome.retryAfterMs) });
    }
    logger.error(log, 'CPG delivery failed permanently');
    appendAuditEvent(db, {
      orgId: d.orgId, actor: 'system:notify', action: 'delivery.failed', targetType: 'delivery', targetId: d.id,
      payload: { integrationId: d.integrationId, channel: d.channel, event: d.event, attempts: attempt, httpStatus: outcome.httpStatus, error: outcome.error?.slice(0, 200) ?? null },
    });
    return finish(db, d, { status: 'failed', attempts: attempt, nextAttemptAt: null });
  }).immediate();
}

function finish(db: Db, d: DeliveryRow, next: Pick<DeliveryRow, 'status' | 'attempts' | 'nextAttemptAt'>): DeliveryRow {
  const updatedAt = new Date().toISOString();
  db.update(cpgNotificationDeliveries).set({ ...next, updatedAt }).where(eq(cpgNotificationDeliveries.id, d.id)).run();
  return { ...d, ...next, updatedAt };
}

// ─── Channels ──────────────────────────────────────────────────────────

async function send(db: Db, i: IntegrationRow, payload: DeliveryPayload): Promise<AttemptOutcome> {
  const s = payload.summary;
  // Decrypted here, just before sending, and never logged.
  const secret = i.secretEnc === null ? null : decryptFromStorage(i.secretEnc);
  if (i.kind === 'email') {
    if (!getResendApiKey()) return { httpStatus: null, error: 'No Resend API key is configured', excerpt: null, permanent: true };
    const r = await sendEmailDetailed({ to: payload.recipients ?? [], ...renderEmail(s), idempotencyKey: s.deliveryId });
    return { httpStatus: r.status, error: r.error, excerpt: r.excerpt };
  }
  if (i.kind === 'webhook') {
    const { url } = JSON.parse(i.config) as WebhookConfig;
    const problem = targetProblem(url);
    if (problem) return { httpStatus: null, error: `Target not allowed: ${problem}`, excerpt: null, permanent: true };
    const { body, headers } = renderWebhook(s, secret!, new Date().toISOString());
    return request(url, { method: 'POST', headers, body });
  }
  return sendJira(db, i, JSON.parse(i.config) as JiraConfig, secret!, s);
}

/**
 * Jira Cloud REST v3. One issue per (integration, case, board): the first
 * event of a lane creates it, later events comment on it. Before creating,
 * the lane's label is searched, so a crash between Jira's 201 and the local
 * link never makes a second issue.
 */
async function sendJira(db: Db, i: IntegrationRow, cfg: JiraConfig, token: string, s: CaseNotificationSummary): Promise<AttemptOutcome> {
  const problem = targetProblem(cfg.baseUrl);
  if (problem) return { httpStatus: null, error: `Target not allowed: ${problem}`, excerpt: null, permanent: true };
  const api = `${cfg.baseUrl}/rest/api/3`;
  const headers = { Authorization: `Basic ${Buffer.from(`${cfg.accountEmail}:${token}`).toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const create = () => request(`${api}/issue`, { method: 'POST', headers, body: JSON.stringify(renderJiraIssue(s, cfg)) });
  if (!s.case || !s.board) return create();

  const lane = and(eq(cpgIntegrationLinks.integrationId, i.id), eq(cpgIntegrationLinks.caseId, s.case.id), eq(cpgIntegrationLinks.boardId, s.board.id));
  let key = db.select({ key: cpgIntegrationLinks.externalKey }).from(cpgIntegrationLinks).where(lane).get()?.key;
  if (!key) {
    const found = await request(`${api}/search/jql?jql=${encodeURIComponent(`labels = "${jiraLabel(s)}"`)}&fields=key`, { method: 'GET', headers });
    if (found.error) return found;
    key = issueKey((found.json as { issues?: Array<{ key?: unknown }> } | undefined)?.issues?.[0]?.key);
    const created = key ? null : await create();
    if (created) {
      key = issueKey((created.json as { key?: unknown } | undefined)?.key);
      if (created.error || !key) return created.error ? created : { ...created, error: 'Jira answered without an issue key', permanent: true };
    }
    db.insert(cpgIntegrationLinks).values({
      id: randomUUID(), orgId: i.orgId, integrationId: i.id, caseId: s.case.id, boardId: s.board.id,
      externalKey: key!, externalUrl: `${cfg.baseUrl}/browse/${key}`, createdAt: new Date().toISOString(),
    }).onConflictDoNothing().run();
    if (created) return created;
  }
  return request(`${api}/issue/${encodeURIComponent(key!)}/comment`, { method: 'POST', headers, body: JSON.stringify(renderJiraComment(s)) });
}

const issueKey = (k: unknown) => (typeof k === 'string' && /^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,10}$/.test(k) ? k : undefined);

/** One HTTP request: no redirects (a 3xx is a failure), 10 s timeout, never throws. */
async function request(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<AttemptOutcome & { json?: unknown }> {
  try {
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    const ok = res.status >= 200 && res.status < 300;
    let json: unknown;
    try { json = ok && text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      httpStatus: res.status, error: ok ? null : `HTTP ${res.status}`, excerpt: text.slice(0, 500), json,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    };
  } catch (err) {
    const e = err as Error;
    return { httpStatus: null, error: (e.name === 'TimeoutError' ? 'Timed out after 10 s' : e.message).slice(0, 500), excerpt: null };
  }
}

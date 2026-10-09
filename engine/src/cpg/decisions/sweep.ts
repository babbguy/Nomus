import { and, eq, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgDecisions } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { refreshOpenCases } from '../cases/service.js';
import { notifyExpiry } from '../notify/outbox.js';
import type { DecisionRow } from './resolve.js';

/**
 * The daily decision sweep (design spec §7.5). Approvals and standing
 * exceptions that are about to expire, or have expired, get one audit marker
 * per (decision, threshold), and every open case is re-derived, so a case
 * whose approval expired leaves `decided`. Idempotent: a second run at the
 * same instant writes nothing. Each notice is queued for the org's
 * integrations in the same transaction (Phase 7).
 */

type Db = BetterSQLite3Database<any>;
const DAY_MS = 86_400_000;
export const EXPIRY_ACTION = 'decision.expiry_notice';

/** Most urgent first: a decision first seen inside 1 day gets the 1-day notice only. */
const THRESHOLDS = [['expired', 0], ['1d', DAY_MS], ['7d', 7 * DAY_MS]] as const;
export type ExpiryThreshold = (typeof THRESHOLDS)[number][0];

export interface ExpiryNotice { decision: DecisionRow; threshold: ExpiryThreshold }
export interface SweepResult { notices: number; casesMoved: number }

export function sweepDecisions(db: Db, now: Date = new Date(), notify: (n: ExpiryNotice) => void = (n) => notifyExpiry(db, n)): SweepResult {
  const at = now.toISOString();
  const horizon = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  return rawSqlite(db).transaction((): SweepResult => {
    const due = db.select().from(cpgDecisions).where(and(
      eq(cpgDecisions.outcome, 'approve'), lte(cpgDecisions.expiresAt, horizon),
      sql`not exists (select 1 from cpg_revocations r where r.decision_id = ${cpgDecisions.id} and r.revoked_at <= ${at})`,
      // Once a decision has its expired notice there is nothing left to say.
      sql`not exists (select 1 from cpg_audit_events e where e.target_id = ${cpgDecisions.id} and e.action = ${EXPIRY_ACTION}
        and json_extract(e.payload, '$.threshold') = 'expired')`,
    )).all();
    const marked = (id: string, threshold: ExpiryThreshold) => rawSqlite(db).prepare(
      `SELECT 1 FROM cpg_audit_events WHERE target_id = ? AND action = ? AND json_extract(payload, '$.threshold') = ?`,
    ).get(id, EXPIRY_ACTION, threshold) !== undefined;
    let notices = 0;
    for (const d of due) {
      const threshold = THRESHOLDS.find(([, ms]) => Date.parse(d.expiresAt!) - now.getTime() <= ms)![0];
      if (marked(d.id, threshold)) continue;
      appendAuditEvent(db, {
        orgId: d.orgId, actor: 'system:sweep', action: EXPIRY_ACTION, targetType: 'decision', targetId: d.id,
        payload: { threshold, scope: d.scope, caseId: d.caseId, expiresAt: d.expiresAt },
      });
      notify({ decision: d, threshold });
      notices += 1;
    }
    return { notices, casesMoved: refreshOpenCases(db, null, 'system:sweep', at) };
  }).immediate();
}

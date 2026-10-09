import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgJustifications } from '../../db/schema-cpg.js';
import { appendAuditEvent } from '../audit/log.js';
import { addCaseEvent, assertLatestFingerprints, openCase, refreshCaseState } from './service.js';

/**
 * Developer justifications (design spec §2.3 T25, §5.4). Append-only: the
 * latest row per (case, fingerprint) is the current one and history is kept.
 * Justifications are keyed by fingerprint, so they carry over to every later
 * revision that still has the finding.
 */

type Db = BetterSQLite3Database<any>;
export type JustificationRow = typeof cpgJustifications.$inferSelect;

/** The current justification of each fingerprint (rows are append-only, so rowid is insertion order). */
export function currentJustifications(db: Db, caseId: string): Map<string, JustificationRow> {
  const rows = db.select().from(cpgJustifications).where(eq(cpgJustifications.caseId, caseId)).orderBy(sql`rowid`).all();
  return new Map(rows.map((r) => [r.fingerprint, r]));
}

/**
 * Justify a finding of the latest revision. Re-sending the current text is a
 * no-op (`added: false`), so retried requests never duplicate history.
 */
export function addJustification(db: Db, input: { orgId: string; caseId: string; userId: string; fingerprint: string; body: string }): { justification: JustificationRow; added: boolean } {
  return rawSqlite(db).transaction(() => {
    const c = openCase(db, input.orgId, input.caseId);
    assertLatestFingerprints(db, c.id, [input.fingerprint]);
    const current = currentJustifications(db, c.id).get(input.fingerprint);
    if (current?.body === input.body) return { justification: current, added: false };

    const actor = `user:${input.userId}`;
    const now = new Date().toISOString();
    const row: JustificationRow = {
      id: randomUUID(), caseId: c.id, orgId: c.orgId, fingerprint: input.fingerprint, authorUserId: input.userId, body: input.body, createdAt: now,
    };
    db.insert(cpgJustifications).values(row).run();
    addCaseEvent(db, c, 'justification_added', actor, { justificationId: row.id, fingerprint: row.fingerprint }, now);
    appendAuditEvent(db, {
      orgId: c.orgId, actor, action: 'case.justification_added', targetType: 'case', targetId: c.id,
      payload: { justificationId: row.id, fingerprint: row.fingerprint },
    });
    refreshCaseState(db, c, actor, now);
    return { justification: row, added: true };
  }).immediate();
}

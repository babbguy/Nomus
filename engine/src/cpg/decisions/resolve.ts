import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cpgDecisions } from '../../db/schema-cpg.js';

/**
 * The snippet and bulk decisions that apply to findings (design spec §7.4
 * step 2). Decisions are bound to (org, repo, fingerprint), so they carry
 * across revisions and branches; the latest one not revoked wins, and only a
 * later approval lifts a rejection.
 */

type Db = BetterSQLite3Database<any>;
export type DecisionRow = typeof cpgDecisions.$inferSelect;

/** The latest snippet or bulk decision of each fingerprint in `repo`, not revoked at `now`. */
export function latestDecisions(db: Db, orgId: string, repo: string, fingerprints: readonly string[], now: string): Map<string, DecisionRow> {
  if (fingerprints.length === 0) return new Map();
  const rows = db.select().from(cpgDecisions).where(and(
    eq(cpgDecisions.orgId, orgId), eq(cpgDecisions.repo, repo), inArray(cpgDecisions.fingerprint, [...new Set(fingerprints)]),
    inArray(cpgDecisions.scope, ['snippet', 'bulk']),
    sql`not exists (select 1 from cpg_revocations r where r.decision_id = ${cpgDecisions.id} and r.revoked_at <= ${now})`,
  )).orderBy(asc(cpgDecisions.finalizedAt), asc(sql`rowid`)).all();
  return new Map(rows.map((d) => [d.fingerprint!, d]));
}

/** A finding is settled by a rejection (never expires) or by an approval that has not expired. */
export function settles(d: DecisionRow | undefined, now: string): d is DecisionRow {
  return d !== undefined && (d.outcome === 'reject' || d.expiresAt! > now);
}

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { cpgDecisions } from '../../db/schema-cpg.js';
import { matchesStanding, snippetReader, standingExceptions, type LocatedFinding } from './standing.js';

/**
 * What settles a blocking finding (design spec §7.4 steps 2 and 3). Snippet
 * and bulk decisions are bound to (org, repo, fingerprint), so they carry
 * across revisions and branches; the latest one not revoked wins, and only a
 * later approval lifts a rejection. Standing exceptions cover what no current
 * snippet decision settles.
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

export interface Cover {
  /** null: nothing settles the finding and no decision was ever made. */
  status: 'rejected' | 'approved' | 'excepted' | 'expired' | null;
  decision?: DecisionRow;
  exception?: DecisionRow;
}

/**
 * §7.4 for one blocking finding: a rejection blocks (it never expires and
 * beats any exception); an unexpired approval passes; an expired one counts
 * as absent, so a matching unexpired standing exception passes (the one that
 * expires last, ties to the lowest id); otherwise the finding is undecided.
 */
export function precedence(decision: DecisionRow | undefined, exceptions: readonly DecisionRow[], now: string): Cover {
  if (decision?.outcome === 'reject') return { status: 'rejected', decision };
  if (decision && decision.expiresAt! > now) return { status: 'approved', decision };
  const exception = exceptions.filter((x) => x.expiresAt! > now)
    .sort((a, b) => b.expiresAt!.localeCompare(a.expiresAt!) || a.id.localeCompare(b.id))[0];
  if (exception) return { status: 'excepted', decision, exception };
  return { status: decision ? 'expired' : null, decision };
}

export const settled = (c: Cover | undefined) => c?.status === 'rejected' || c?.status === 'approved' || c?.status === 'excepted';

/**
 * The cover of each fingerprint in `repo` at `now`. A standing exception
 * covers a fingerprint only when it matches every occurrence given; a
 * fingerprint with no located occurrence is never excepted (fail closed).
 */
export function coverFindings(db: Db, orgId: string, fingerprints: readonly string[], occurrences: readonly (LocatedFinding & { fingerprint: string })[], repo: string, now: string): Map<string, Cover> {
  const decisions = latestDecisions(db, orgId, repo, fingerprints, now);
  const exceptions = standingExceptions(db, orgId).filter((x) => x.revocation === null || x.revocation.revokedAt > now);
  const snippetOf = snippetReader(db, orgId);
  return new Map([...new Set(fingerprints)].map((fp) => {
    const located = occurrences.filter((o) => o.fingerprint === fp);
    const matching = located.length === 0 ? [] : exceptions.filter((x) => located.every((o) => matchesStanding(o, x, snippetOf))).map((x) => x.decision);
    return [fp, precedence(decisions.get(fp), matching, now)];
  }));
}

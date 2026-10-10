import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { checkRegexSafety, compileGlobList, globError, repoPatternError } from '@nomus/scanner/corporate';
import {
  cpgCaseFindings, cpgCaseRevisions, cpgCases, cpgDecisions, cpgPolicyHeads, cpgProposals, cpgRevocations, cpgSnippets, cpgTeamRepos, cpgTeams,
} from '../../db/schema-cpg.js';
import { standingPatternSchema, type StandingPattern } from '../contracts.js';
import { CpgError } from '../errors.js';
import { can, type CpgActor } from '../rbac/can.js';
import type { CaseRow } from '../cases/service.js';
import type { DecisionRow } from './resolve.js';

/**
 * Standing exceptions (design spec §7): a finalized approval that covers
 * future findings matching a pattern. Exceptions are pinned to one policy
 * version (D11), and teams are resolved to their repository patterns at match
 * time, so archiving a team or changing its repositories takes effect at once.
 */

/** One occurrence of a finding, located in a repository and branch. */
export interface LocatedFinding {
  repo: string;
  branch: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string | null;
  policyKey: string;
  policyVersion: number;
  snippetHash: string;
}

/** A pattern with its teams resolved to repository patterns. */
export interface StandingRule {
  pattern: StandingPattern;
  teamRepos: readonly string[];
}

export interface StandingException extends StandingRule {
  decision: DecisionRow;
  revocation: typeof cpgRevocations.$inferSelect | null;
  /** The policy's active version now (null when retired); any other version means the exception has lapsed (D11). */
  activeVersion: number | null;
}

const anyGlob = (globs: readonly string[], value: string) => globs.length > 0 && compileGlobList(globs)(value);

/** §7.3 conditions 1 to 7; condition 8 (finalized, unexpired, not revoked) belongs to the caller. */
export function matchesStanding(f: LocatedFinding, rule: StandingRule, snippetOf: (hash: string) => string | undefined): boolean {
  const p = rule.pattern;
  const c = p.conditions;
  if (f.policyKey !== p.policyKey || f.policyVersion !== p.policyVersion) return false;
  if (!anyGlob([...p.repos, ...rule.teamRepos], f.repo)) return false;
  if (!anyGlob(p.paths, f.filePath) || anyGlob(p.excludePaths, f.filePath)) return false;
  if (c.branches && !anyGlob(c.branches, f.branch)) return false;
  if (c.languages && (f.language === null || !(c.languages as readonly string[]).includes(f.language))) return false;
  if (c.maxLinesPerFinding !== undefined && f.endLine - f.startLine + 1 > c.maxLinesPerFinding) return false;
  if (c.snippetMustMatch) {
    // Fail closed: without the stored snippet the condition cannot hold.
    const text = snippetOf(f.snippetHash);
    if (text === undefined || !new RegExp(c.snippetMustMatch.source, c.snippetMustMatch.flags).test(text)) return false;
  }
  return true;
}

const isLiteral = (glob: string) => !/[*?{]/.test(glob);

/**
 * Whether `actor` holds `permission` on every repository the pattern can
 * touch: each literal repository, or an org-scoped grant when the pattern has
 * a repository glob or a team.
 */
export function canOnPattern(actor: Pick<CpgActor, 'grants'>, permission: string, p: StandingPattern): boolean {
  if (p.teamIds.length > 0 || !p.repos.every(isLiteral)) return can(actor, permission);
  return p.repos.every((repo) => can(actor, permission, { repo }));
}

/** Write-time checks zod cannot make (§7.1, §4.3 step 8). */
export function assertPattern(db: Db, orgId: string, p: StandingPattern, allowOrgWide: boolean): void {
  const errors = [
    ...p.repos.map(repoPatternError),
    ...[...p.paths, ...p.excludePaths, ...(p.conditions.branches ?? [])].map(globError),
  ].filter((e): e is string => e !== null);
  if (errors.length > 0) throw new CpgError(422, 'invalid_glob', 'Invalid glob in the pattern', { errors });
  // A wildcard in the host segment matches repositories across the whole organization.
  if (!allowOrgWide && p.repos.some((r) => /[*?{]/.test(r.split('/')[0]))) {
    throw new CpgError(422, 'org_wide_pattern_forbidden', 'Organization-wide repository patterns are not allowed by the quorum configuration');
  }
  const regex = p.conditions.snippetMustMatch;
  const safety = regex ? checkRegexSafety(regex.source, regex.flags) : null;
  if (safety && !safety.ok) throw new CpgError(422, 'invalid_regex', 'snippetMustMatch is not a safe pattern', { reasons: safety.reasons });
  const known = new Set(p.teamIds.length === 0 ? [] : db.select({ id: cpgTeams.id }).from(cpgTeams)
    .where(and(eq(cpgTeams.orgId, orgId), inArray(cpgTeams.id, p.teamIds), isNull(cpgTeams.archivedAt))).all().map((t) => t.id));
  const unknown = p.teamIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new CpgError(422, 'unknown_team', 'Not an active team of this organization', { teamIds: unknown });
}

/** The repository patterns of each non-archived team of the org. */
function teamRepos(db: Db, orgId: string): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const r of db.select({ teamId: cpgTeamRepos.teamId, pattern: cpgTeamRepos.repoPattern }).from(cpgTeamRepos)
    .innerJoin(cpgTeams, eq(cpgTeams.id, cpgTeamRepos.teamId))
    .where(and(eq(cpgTeams.orgId, orgId), isNull(cpgTeams.archivedAt))).all()) {
    by.set(r.teamId, [...(by.get(r.teamId) ?? []), r.pattern]);
  }
  return by;
}

const resolveRule = (pattern: StandingPattern, teams: Map<string, string[]>): StandingRule =>
  ({ pattern, teamRepos: pattern.teamIds.flatMap((id) => teams.get(id) ?? []) });

/** Every standing exception of the org, oldest first, with its pattern (from the immutable proposal) and revocation. */
export function standingExceptions(db: Db, orgId: string): StandingException[] {
  const rows = db.select({ decision: cpgDecisions, pattern: cpgProposals.pattern, revocation: cpgRevocations, head: cpgPolicyHeads }).from(cpgDecisions)
    .innerJoin(cpgProposals, eq(cpgProposals.id, cpgDecisions.proposalId))
    .leftJoin(cpgRevocations, eq(cpgRevocations.decisionId, cpgDecisions.id))
    .leftJoin(cpgPolicyHeads, eq(cpgPolicyHeads.policyId, cpgDecisions.policyId))
    .where(and(eq(cpgDecisions.orgId, orgId), eq(cpgDecisions.scope, 'standing'), eq(cpgDecisions.outcome, 'approve')))
    .orderBy(asc(cpgDecisions.finalizedAt), asc(cpgDecisions.id)).all();
  if (rows.length === 0) return [];
  const teams = teamRepos(db, orgId);
  return rows.map((r) => ({
    ...resolveRule(standingPatternSchema.parse(JSON.parse(r.pattern!)), teams), decision: r.decision, revocation: r.revocation,
    activeVersion: r.head?.state === 'active' ? r.head.activeVersion : null,
  }));
}

/** The pattern of a standing proposal or decision's proposal, teams resolved now. */
export function ruleOf(db: Db, orgId: string, pattern: string): StandingRule {
  return resolveRule(standingPatternSchema.parse(JSON.parse(pattern)), teamRepos(db, orgId));
}

/** Normalized snippet text by hash, read lazily and cached for one evaluation. */
export function snippetReader(db: Db, orgId: string): (hash: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (hash) => {
    if (!cache.has(hash)) {
      cache.set(hash, db.select({ text: cpgSnippets.normalizedText }).from(cpgSnippets)
        .where(and(eq(cpgSnippets.orgId, orgId), eq(cpgSnippets.snippetHash, hash))).get()?.text);
    }
    return cache.get(hash);
  };
}

/** The open cases whose latest revision has a finding the rule matches (for the self-approval ban). */
export function coveredOpenCases(db: Db, orgId: string, rule: StandingRule): CaseRow[] {
  const snippetOf = snippetReader(db, orgId);
  const rows = db.select({ kase: cpgCases, finding: cpgCaseFindings }).from(cpgCases)
    .innerJoin(cpgCaseRevisions, and(eq(cpgCaseRevisions.caseId, cpgCases.id), eq(cpgCaseRevisions.revision, cpgCases.latestRevision)))
    .innerJoin(cpgCaseFindings, eq(cpgCaseFindings.revisionId, cpgCaseRevisions.id))
    .where(and(eq(cpgCases.orgId, orgId), isNull(cpgCases.closedAt),
      eq(cpgCaseFindings.policyKey, rule.pattern.policyKey), eq(cpgCaseFindings.policyVersion, rule.pattern.policyVersion))).all();
  const covered = new Map<string, CaseRow>();
  for (const { kase, finding } of rows) {
    if (matchesStanding({ ...finding, repo: kase.repo, branch: kase.branch }, rule, snippetOf)) covered.set(kase.id, kase);
  }
  return [...covered.values()];
}

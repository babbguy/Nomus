import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { canonicalRepo } from '@nomus/scanner/corporate';
import { githubAppInstallations } from '../../db/schema.js';
import { cpgCases } from '../../db/schema-cpg.js';
import { getOrgSettings } from '../rbac/seed.js';
import { closeCase } from './close.js';
import { attachPullRequest } from './service.js';

/**
 * The GitHub App's part in review cases (design spec §1.15, §5.3 rows 8 and
 * 9): `pull_request.opened` attaches the PR to the open case of its head
 * branch, and `pull_request.closed` closes that case as merged or
 * pr_closed_unmerged. Organizations without corporate policies switched on,
 * and branches without an open case, are left alone.
 */

type Db = BetterSQLite3Database<any>;

export interface PullRequestEvent {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { number?: number; merged?: boolean; head?: { ref?: string } };
}

export type PullRequestOutcome = 'attached' | 'closed' | 'ignored';

export function applyCpgPullRequest(db: Db, installationId: number, payload: PullRequestEvent): PullRequestOutcome {
  if (payload.action !== 'opened' && payload.action !== 'closed') return 'ignored';
  const orgId = db.select({ orgId: githubAppInstallations.orgId }).from(githubAppInstallations)
    .where(eq(githubAppInstallations.installationId, installationId)).get()?.orgId;
  if (!orgId || !getOrgSettings(db, orgId)?.enabled) return 'ignored';

  const repo = canonicalRepo(payload.repository?.full_name ?? '');
  const branch = payload.pull_request?.head?.ref;
  const prNumber = payload.pull_request?.number;
  if (!repo || !branch || !Number.isInteger(prNumber) || prNumber! < 1) {
    throw new Error(`pull_request.${payload.action}: the payload has no repository, head branch or PR number`);
  }
  const kase = db.select().from(cpgCases)
    .where(and(eq(cpgCases.orgId, orgId), eq(cpgCases.repo, repo), eq(cpgCases.branch, branch), isNull(cpgCases.closedAt))).get();
  if (!kase) return 'ignored';

  const actor = `github_app:${installationId}`;
  if (payload.action === 'opened') {
    attachPullRequest(db, orgId, kase.id, prNumber!, actor);
    return 'attached';
  }
  closeCase(db, {
    orgId, caseId: kase.id, actor,
    reason: payload.pull_request?.merged === true ? 'merged' : 'pr_closed_unmerged',
    note: `Pull request #${prNumber} was ${payload.pull_request?.merged === true ? 'merged' : 'closed without merging'}`,
  });
  return 'closed';
}

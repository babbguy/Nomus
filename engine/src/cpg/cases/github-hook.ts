import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { canonicalRepo } from '@nomus/scanner/corporate';
import { githubAppInstallations } from '../../db/schema.js';
import { getOrgSettings } from '../rbac/seed.js';
import { closeForPullRequest } from '../ci/pr-closed.js';
import { attachPullRequest, findOpenCase } from './service.js';

/**
 * The GitHub App's part in review cases (design spec §1.15, §5.3 rows 8 and
 * 9): `pull_request.opened` attaches the PR to the open case of its head
 * branch, and `pull_request.closed` closes that case as merged or
 * pr_closed_unmerged. Organizations without corporate policies switched on,
 * and branches without an open case, are left alone.
 */

interface PullRequestEvent {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: { number?: number; merged?: boolean; head?: { ref?: string } };
}

type PullRequestOutcome = 'attached' | 'closed' | 'ignored';

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
  const actor = `github_app:${installationId}`;
  if (payload.action === 'closed') {
    const { closed } = closeForPullRequest(db, orgId, { repo, branch, prNumber: prNumber!, merged: payload.pull_request?.merged === true }, actor);
    return closed ? 'closed' : 'ignored';
  }
  const kase = findOpenCase(db, { orgId, repo, branch });
  if (!kase) return 'ignored';
  attachPullRequest(db, orgId, kase.id, prNumber!, actor);
  return 'attached';
}

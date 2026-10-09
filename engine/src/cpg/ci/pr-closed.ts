import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PrClosedRequest } from '@nomus/scanner/corporate';
import { closeCase } from '../cases/close.js';
import { findOpenCase } from '../cases/service.js';

/**
 * A pull request closed (design spec §5.3 rows 8 and 9): the open case of its
 * head branch closes as `merged` or `pr_closed_unmerged`. Shared by the CI
 * route (E62) and the GitHub App hook. A branch without an open case, or
 * whose case is attached to another pull request, is left alone.
 */
export function closeForPullRequest(
  db: BetterSQLite3Database<any>, orgId: string, pr: PrClosedRequest, actor: string,
): { caseId: string | null; closed: boolean } {
  const kase = findOpenCase(db, { orgId, repo: pr.repo, branch: pr.branch });
  if (!kase || (kase.prNumber !== null && kase.prNumber !== pr.prNumber)) return { caseId: null, closed: false };
  const how = pr.merged ? `merged${pr.mergeSha ? ` as ${pr.mergeSha}` : ''}` : 'closed without merging';
  closeCase(db, {
    orgId, caseId: kase.id, actor, reason: pr.merged ? 'merged' : 'pr_closed_unmerged', note: `Pull request #${pr.prNumber} was ${how}`,
  });
  return { caseId: kase.id, closed: true };
}

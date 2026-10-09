import type { ActorRef, CaseComment, CaseDetail, CaseState, CpgMe, LaneState, ResolutionStatus } from '../api/cpg';
import { formatActor } from './cpg-permissions';

/** Labels and pure rules of the review-case pages. No React, no network. */

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export const CASE_STATE_LABEL: Record<CaseState, string> = {
  open: 'Open', in_review: 'In review', changes_requested: 'Changes requested', decided: 'Decided', closed: 'Closed',
};
export const CASE_STATE_VARIANT: Record<CaseState, Variant> = {
  open: 'default', in_review: 'info', changes_requested: 'warning', decided: 'success', closed: 'default',
};

export const LANE_STATE_LABEL: Record<LaneState, string> = { needs_review: 'Needs review', changes_requested: 'Changes requested', decided: 'Decided' };
export const LANE_STATE_VARIANT: Record<LaneState, Variant> = { needs_review: 'info', changes_requested: 'warning', decided: 'success' };

export const RESOLUTION_LABEL: Record<ResolutionStatus, string> = {
  advisory: 'Advisory', grace: 'Grace period', approved: 'Approved', excepted: 'Excepted', rejected: 'Rejected',
  expired: 'Approval expired', pending: 'Decision pending', changes_requested: 'Changes requested', needs_review: 'Needs review',
};
export const RESOLUTION_VARIANT: Record<ResolutionStatus, Variant> = {
  advisory: 'default', grace: 'default', approved: 'success', excepted: 'success', rejected: 'danger',
  expired: 'warning', pending: 'info', changes_requested: 'warning', needs_review: 'info',
};

const CLOSE_REASON_LABEL: Record<string, string> = {
  merged: 'Merged', withdrawn: 'Withdrawn', closed_by_reviewer: 'Closed by a reviewer', pr_closed_unmerged: 'Pull request closed unmerged', abandoned: 'Abandoned',
};
export const closeReasonLabel = (reason: string | null) => (reason ? CLOSE_REASON_LABEL[reason] ?? reason : '—');

export const SOURCE_LABEL = { vscode: 'VS Code', ci: 'CI', dashboard: 'Dashboard' } as const;

export const actorLabel = (ref: ActorRef) => ref.name || formatActor(ref.actor);

/** Text ending in exactly one sentence mark: a full stop is added only when none is there. */
export const asSentence = (text: string) => (/[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`);

/**
 * A repository path or branch split after each `/` and `.`: the only places
 * it may wrap, never mid-name.
 */
export const breakablePath = (path: string) => path.split(/(?<=[/.])/);

/**
 * A pull request link. Canonical repositories drop the github.com host
 * (owner/name), so only those are known to be on GitHub; another host gets
 * no link rather than a guessed one.
 */
export function pullRequestUrl(repo: string, prNumber: number | null): string | null {
  if (prNumber === null || repo.split('/').length !== 2) return null;
  return `https://github.com/${repo}/pull/${prNumber}`;
}

/**
 * What to say about a page of the case list. The server pages first and then
 * leaves out cases in repositories the caller cannot read, so a page can be
 * short, or empty, while later pages still hold cases.
 */
export function pageNote(shown: number, limit: number, hasNext: boolean): string | null {
  if (!hasNext || shown >= limit) return null;
  return shown === 0
    ? 'No case on this page is in a repository you can read. Later pages may have some: use Next.'
    : 'This page shows fewer cases than usual because it leaves out repositories you cannot read. Later pages may have more.';
}

export interface Thread {
  root: CaseComment;
  replies: CaseComment[];
}

/** Comments grouped into threads, oldest first (the server returns them in order). */
export function threadsOf(comments: CaseComment[]): Thread[] {
  const threads = new Map<string, Thread>();
  for (const c of comments) {
    if (c.parentId === null) threads.set(c.id, { root: c, replies: [] });
    else threads.get(c.threadId)?.replies.push(c);
  }
  return [...threads.values()];
}

export interface CaseActions {
  /** Why nothing can be changed (closed, governance off); null when the case is writable. */
  readOnly: string | null;
  comment: string | null;
  /** The lanes the caller may request changes on. */
  reviewLanes: CaseDetail['case']['lanes'];
  /** Why request changes is not offered, when the caller is close to being able to. */
  reviewBlocked: string | null;
  /** The opener withdraws their case; someone else with case.close closes it. */
  end: 'withdraw' | 'close' | null;
}

/**
 * What the caller may do on a case, from the server's view of their
 * permissions on its repository plus their board memberships. A reason is
 * given when an action is held back (the server re-checks every write).
 */
export function caseActions(detail: CaseDetail, me: CpgMe | null): CaseActions {
  const v = detail.viewer;
  const lanes = detail.case.lanes;
  const myBoards = new Set((me?.boards ?? []).map((b) => b.id));
  const reviewLanes = v.review ? lanes.filter((l) => myBoards.has(l.boardId)) : [];
  const readOnly = detail.case.state === 'closed' ? 'This case is closed: it can no longer be changed.'
    : me && !me.cpgEnabled ? 'Governance is off for this organization, so cases cannot be changed until an Org Admin turns it on.'
      : null;
  const laneNames = lanes.map((l) => l.boardName).join(' or ');
  const reviewBlocked = !v.review || reviewLanes.length > 0 || lanes.length === 0 ? null
    : `Only members of the ${laneNames} can request changes on this case.`;
  return {
    readOnly,
    comment: v.comment ? null : 'Commenting needs the case.comment permission on this repository.',
    reviewLanes,
    reviewBlocked,
    end: me && detail.openedBy.actor === `user:${me.user.id}` && v.withdraw ? 'withdraw' : v.close ? 'close' : null,
  };
}

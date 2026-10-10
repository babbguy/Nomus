import type { CaseDetail, CaseFinding, CpgMe, Proposal, ProposalStatus, QuorumConfig, QuorumScope, StandingException, Tier } from '../api/cpg';
import { holdsPermission } from './cpg-permissions';

/** Labels and pure rules of the decision and standing-exception views. No React, no network. */

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const DAY = 86_400_000;

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  pending: 'Pending', finalized: 'Decided', vetoed: 'Vetoed', invalidated: 'Invalidated', void: 'Void (case closed)', lapsed: 'Proposal lapsed',
};
export const PROPOSAL_STATUS_VARIANT: Record<ProposalStatus, Variant> = {
  pending: 'info', finalized: 'success', vetoed: 'danger', invalidated: 'warning', void: 'default', lapsed: 'default',
};

export type ExceptionStatus = StandingException['status'] | 'pending' | 'not_approved';
export const EXCEPTION_STATUSES: readonly ExceptionStatus[] = ['pending', 'active', 'expired', 'revoked', 'lapsed', 'not_approved'];
export const EXCEPTION_STATUS_LABEL: Record<ExceptionStatus, string> = {
  pending: 'Pending', active: 'Active', expired: 'Expired', revoked: 'Revoked', lapsed: 'Lapsed (policy changed)', not_approved: 'Not approved',
};
export const EXCEPTION_STATUS_VARIANT: Record<ExceptionStatus, Variant> = {
  pending: 'info', active: 'success', expired: 'default', revoked: 'danger', lapsed: 'warning', not_approved: 'default',
};

/** Why the server would refuse the caller's vote (`viewer.reason` codes). */
const VOTE_BLOCKED: Record<string, string> = {
  proposal_not_pending: 'Voting has closed on this proposal.',
  already_voted: 'You have already voted on this proposal.',
  self_approval_forbidden: 'You proposed this, or opened, justified or revised a case it decides, so you cannot vote on it (four-eyes).',
  not_eligible_voter: 'Only active members of a required board can vote.',
  forbidden: 'Voting needs the case.review permission (or exception.approve for a standing exception) on every repository it covers.',
  case_closed: 'The case is closed.',
};
export const voteBlockedText = (code: string | null) => (code ? VOTE_BLOCKED[code] ?? `Voting is not possible (${code}).` : '');

const INVALIDATION: Record<string, string> = {
  expiry_out_of_range: 'its expiry is beyond the maximum the quorum configuration now allows',
  policy_version_not_active: 'the policy has a newer active version',
  scope_not_allowed: 'the quorum configuration no longer allows this kind of decision',
  no_active_owning_board: 'no active board owns the policy any more',
};
/** Why a proposal was invalidated, from its reason code. */
export const invalidationText = (code: string) => INVALIDATION[code] ?? code.replace(/_/g, ' ');

/** One proposal's progress toward its quorum. */
export interface QuorumProgress {
  approvals: number;
  required: number;
  /** Required boards that still need an approving member. */
  missingBoardIds: string[];
  /** Whether an approver holding the required permission is still needed. */
  missingPermission: string | null;
}

export function quorumProgress(p: Pick<Proposal, 'votes' | 'required'>): QuorumProgress {
  const approving = p.votes.filter((v) => v.vote === 'approve');
  const covered = new Set(approving.flatMap((v) => v.boards));
  const { boardIds, boardCoverage, requiredPermission } = p.required;
  const missingBoardIds = boardCoverage === 'all_owning' ? boardIds.filter((b) => !covered.has(b))
    : boardIds.some((b) => covered.has(b)) ? [] : boardIds;
  return {
    approvals: approving.length,
    required: p.required.approvals,
    missingBoardIds,
    missingPermission: requiredPermission && !approving.some((v) => v.permissions.includes(requiredPermission)) ? requiredPermission : null,
  };
}

/** "1 of 2 approvals; still needed: an approver from Legal Board", or "2 approvals, 1 required" once met. */
export function progressText(q: QuorumProgress, boardName: (id: string) => string): string {
  const needed = [
    ...(q.missingBoardIds.length > 0 ? [`an approver from ${q.missingBoardIds.map(boardName).join(' and ')}`] : []),
    ...(q.missingPermission ? [`an approver holding ${q.missingPermission}`] : []),
  ];
  const count = q.approvals < q.required ? `${q.approvals} of ${q.required} approval${q.required === 1 ? '' : 's'}`
    : `${q.approvals} approval${q.approvals === 1 ? '' : 's'}, ${q.required} required`;
  return `${count}${needed.length > 0 ? `; still needed: ${needed.join(', ')}` : ''}`;
}

/** The expiry a new approval may have, under the quorum in force (spec §4.3 steps 1 and 6). */
export interface ExpiryRule {
  maxDays: number;
  defaultDays: number;
  approvals: number;
  boardCoverage: 'all_owning' | 'any_owning';
  requiredPermission: string | null;
}

/** The effective rule for a scope on a policy (an override replaces the tier's whole slot), or null when not allowed. */
export function scopeRule(config: QuorumConfig, policyId: string, tier: Tier, scope: QuorumScope): ExpiryRule | null {
  if (tier === 'advisory') return null;
  const slot = config.policyOverrides[policyId]?.[scope] ?? config.tiers[tier][scope];
  if (!slot.allowed) return null;
  const maxDays = scope === 'standing' ? Math.min(slot.maxExpiryDays, config.standingExceptions.maxExpiryDays) : slot.maxExpiryDays;
  return {
    maxDays, defaultDays: Math.min(slot.defaultExpiryDays, maxDays),
    approvals: slot.approvals, boardCoverage: slot.boardCoverage, requiredPermission: slot.requiredPermission,
  };
}

/** "2 approvals covering every owning board, one of them holding exception.approve". */
export function requirementText(r: Pick<ExpiryRule, 'approvals' | 'boardCoverage' | 'requiredPermission'>): string {
  const who = r.boardCoverage === 'all_owning' ? 'covering every owning board' : 'from an owning board';
  const permission = r.requiredPermission ? `, ${r.approvals === 1 ? 'held by' : 'one of them by'} someone holding ${r.requiredPermission} (the Exception Approver role)` : '';
  return `${r.approvals} approval${r.approvals === 1 ? '' : 's'} ${who}${permission}`;
}

/** Midnight-free arithmetic: `days` whole days after `now`, as UTC ISO-8601. */
export const isoInDays = (days: number, now: number) => new Date(now + days * DAY).toISOString();

/** A whole number of days within 1..max, or null. */
export function parseDays(text: string, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= max ? n : null;
}

/**
 * Why the caller may not propose or vote on a case's findings at all, or null.
 * Self-approval is never offered: the server would refuse it (403).
 */
export function decideBlocked(detail: CaseDetail, me: CpgMe | null): string | null {
  if (!detail.viewer.review) return 'Deciding needs the case.review permission on this repository.';
  if (detail.viewer.selfApproval) return 'You opened, justified or revised this case, so you cannot propose or vote on its decisions (four-eyes).';
  if (!me) return 'Your permissions are still loading.';
  return null;
}

/** Whether the caller is a member of a board that owns the finding (a required board). */
export const ownsFinding = (me: CpgMe | null, f: Pick<CaseFinding, 'owningBoardIds'>) =>
  !!me && me.boards.some((b) => f.owningBoardIds.includes(b.id));

/** Findings a new proposal may decide: blocking, not covered by a pending proposal, and not settled by an approval or exception. */
export const OPEN_FOR_PROPOSAL = new Set(['needs_review', 'changes_requested', 'expired', 'rejected']);

/** Bulk candidates: open findings grouped by policy version, two or more each. Prohibited is never bulk-decided. */
export function bulkGroups(findings: CaseFinding[], openFingerprints: ReadonlySet<string>): Array<{ key: string; title: string; findings: CaseFinding[] }> {
  const groups = new Map<string, { key: string; title: string; findings: CaseFinding[] }>();
  for (const f of findings) {
    if (f.tier !== 'review-required' || !openFingerprints.has(f.fingerprint)) continue;
    const key = `${f.policyKey} v${f.policyVersion}`;
    const g = groups.get(key) ?? { key, title: f.policyTitle, findings: [] };
    g.findings.push(f);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.findings.length >= 2);
}

/** One row of the exceptions page: a standing proposal and, once finalized, its exception. */
export interface ExceptionRow {
  proposal: Proposal;
  exception: StandingException | null;
  status: ExceptionStatus;
}

export function exceptionRows(proposals: Proposal[], exceptions: StandingException[]): ExceptionRow[] {
  const byProposal = new Map(exceptions.map((x) => [x.proposalId, x]));
  return proposals.map((proposal) => {
    const exception = byProposal.get(proposal.id) ?? null;
    const status: ExceptionStatus = exception ? exception.status : proposal.status === 'pending' ? 'pending' : 'not_approved';
    return { proposal, exception, status };
  }).reverse();
}

/** What the caller may do on the exceptions page (the server re-checks each write on every repository). */
export function exceptionActions(me: CpgMe | null) {
  return { propose: holdsPermission(me, 'exception.propose'), revoke: holdsPermission(me, 'decision.revoke') };
}

/** Exceptions that a new version of the policy would lapse (D11): active on its current version. */
export const lapsingCount = (exceptions: StandingException[], policyKey: string, activeVersion: number | null) =>
  exceptions.filter((x) => x.status === 'active' && x.policyKey === policyKey && x.policyVersion === activeVersion).length;

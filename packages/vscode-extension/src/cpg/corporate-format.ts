// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import type { CorporateFinding } from '@nomus/scanner';
import type { CaseStatus } from '@nomus/scanner/corporate';
import type { BundleState } from './bundle-cache';

/**
 * Text and severity for corporate findings (design spec §10.2), kept free
 * of the `vscode` module so it is unit-tested directly. Regulatory
 * diagnostics never go through this file.
 */

export type CorporateSeverity = 'error' | 'warning' | 'information' | 'hint';

/** `2026-10-09 13:45 UTC` from an ISO-8601 instant ('unknown time' when it does not parse). */
export function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  const d = new Date(t).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
}

/** The day part of an ISO-8601 instant. */
export function formatDay(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'an unknown date' : new Date(t).toISOString().slice(0, 10);
}

/** A finding's server resolution (E53 / the case's resolutions), matched by fingerprint. */
export type Resolution = CaseStatus['resolutions'][number];

/** The server's decision, when it says more than the local scan (§10.4); `undefined` otherwise. */
function decisionText(r: Resolution | undefined): string | undefined {
  switch (r?.status) {
    case 'approved': return `approved until ${formatDay(r.expiresAt ?? '')}`;
    case 'excepted': return `excepted (standing exception) until ${formatDay(r.expiresAt ?? '')}`;
    case 'rejected': return 'rejected';
    case 'pending': return 'decision pending';
    case 'changes_requested': return 'changes requested';
    case 'expired': return 'approval expired; needs review';
    default: return undefined;
  }
}

export function statusText(f: Pick<CorporateFinding, 'status' | 'enforceFrom'>, r?: Resolution): string {
  const decided = decisionText(r);
  if (decided) return decided;
  switch (f.status) {
    case 'needs_review': return 'needs review';
    case 'grace': return `advisory; enforced from ${formatDay(f.enforceFrom)}`;
    case 'advisory': return 'advisory';
  }
}

/**
 * Approved or excepted → Hint; rejected → Error. Otherwise blocking
 * prohibited → Error, blocking review-required → Warning, advisory and grace
 * → Information.
 */
export function corporateSeverity(f: Pick<CorporateFinding, 'blocking' | 'tier'>, r?: Resolution): CorporateSeverity {
  if (r?.status === 'approved' || r?.status === 'excepted') return 'hint';
  if (r?.status === 'rejected') return 'error';
  if (!f.blocking) return 'information';
  return f.tier === 'prohibited' ? 'error' : 'warning';
}

/** `[Policy · PROHIBITED] corp.no-direct-openai v2: <message> Status: needs review.` */
export function corporateMessage(f: CorporateFinding, r?: Resolution): string {
  const message = f.rule.message.trim().replace(/[.!?]*$/, '.');
  return `[Policy · ${f.tier.toUpperCase()}] ${f.policyKey} v${f.policyVersion}: ${message} Status: ${statusText(f, r)}.`;
}

export function ownersText(f: Pick<CorporateFinding, 'rule'>): string {
  // By name: the bundle lists boards by id, which differs between servers.
  return `Owned by: ${f.rule.owningBoards.map((b) => b.name).sort((a, b) => a.localeCompare(b)).join(', ')}`;
}

/** The status row of the Corporate Policies view (§10.2, §10.5). */
export function bundleStatusText(state: BundleState): string {
  switch (state.kind) {
    case 'verified': {
      const n = state.bundle.enabled ? state.bundle.policies.length : 0;
      return `Policy bundle: ${n} ${n === 1 ? 'policy' : 'policies'} · verified ${formatUtc(state.checkedAt)}`;
    }
    case 'offline': return `Policy bundle: offline (cached ${formatUtc(state.fetchedAt)})`;
    case 'expired': return `Policy bundle expired: offline and older than the allowed age (cached ${formatUtc(state.fetchedAt)})`;
    case 'unavailable': return 'Policy bundle unavailable';
    case 'rejected': return 'Policy bundle rejected: signature or contract verification failed';
    case 'denied': return `Policy bundle refused by the server (HTTP ${state.status})`;
    case 'not_supported': return 'This Nomus server does not support corporate policies';
  }
}

export interface FindingGroup {
  id: 'blocking' | 'decided' | 'advisory';
  label: string;
  findings: CorporateFinding[];
}

const passes = (r: Resolution | undefined) => r?.status === 'approved' || r?.status === 'excepted';

/** Findings grouped for the view: blocking, approved or excepted by the server, and advisory/grace. */
export function groupFindings(findings: readonly CorporateFinding[], resolutionOf: (fingerprint: string) => Resolution | undefined = () => undefined): FindingGroup[] {
  const decided = findings.filter((f) => f.blocking && passes(resolutionOf(f.fingerprint)));
  return [
    { id: 'blocking' as const, label: 'Blocking: needs review', findings: findings.filter((f) => f.blocking && !decided.includes(f)) },
    { id: 'decided' as const, label: 'Approved or excepted', findings: decided },
    { id: 'advisory' as const, label: 'Advisory / grace period', findings: findings.filter((f) => !f.blocking) },
  ].filter((g) => g.findings.length > 0);
}

// ─── Review cases (§10.3, §10.4) ───────────────────────────────────────

type CaseState = CaseStatus['state'];

/** A server message as a sentence ("Missing permission case.read" → "Missing permission case.read."). */
export function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function caseStateText(state: CaseState): string {
  switch (state) {
    case 'open': return 'open: some blocking findings have no justification';
    case 'in_review': return 'in review';
    case 'changes_requested': return 'changes requested';
    case 'decided': return 'decided';
    case 'closed': return 'closed';
  }
}

/** `Case CPG-1A2B3C4D · in review (revision 3)` */
export function caseLabel(c: Pick<CaseStatus, 'ref' | 'state' | 'latestRevision'>): string {
  return `Case ${c.ref} · ${caseStateText(c.state)} (revision ${c.latestRevision})`;
}

/** `AI Review Board: needs review (2 blocking)` */
export function laneText(l: CaseStatus['lanes'][number]): string {
  if (l.state === 'changes_requested') return `${l.boardName}: changes requested`;
  if (l.state === 'decided') return l.blocking === 0 ? `${l.boardName}: nothing to decide` : `${l.boardName}: decided (${l.decided} of ${l.blocking})`;
  return `${l.boardName}: needs review (${l.blocking} blocking)`;
}

function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** `Changes requested by Dana (Legal): "Move the call behind…"` */
export function changeRequestText(r: CaseStatus['openChangeRequests'][number], max = 80): string {
  return `Changes requested by ${r.authorName} (${r.boardName}): "${excerpt(r.body, max)}"`;
}

const boardsOf = (c: CaseStatus) => c.lanes.filter((l) => l.blocking > 0).map((l) => l.boardName).sort((a, b) => a.localeCompare(b)).join(', ');

/** The confirmation after request review (E40). */
export function reviewResultText(r: { created: boolean; revisionCreated: boolean; case: CaseStatus }): string {
  const c = r.case;
  const sent = boardsOf(c) ? ` Sent to: ${boardsOf(c)}.` : '';
  if (r.created) return `Review case ${c.ref} opened (revision ${c.latestRevision}).${sent}`;
  if (r.revisionCreated) return `Review case ${c.ref} updated (revision ${c.latestRevision}).${sent}`;
  return `Review case ${c.ref}: justifications recorded (the code is unchanged since revision ${c.latestRevision}).${sent}`;
}

export interface CaseNotice { level: 'info' | 'warning'; text: string; actions?: string[] }

const DECIDED = ['approved', 'excepted', 'rejected'] as const;

/** What changed on the branch's case since the last poll (`prev` null: never seen on this machine). */
export function caseNotices(prev: CaseStatus | null, next: CaseStatus): CaseNotice[] {
  const notices: CaseNotice[] = [];
  const seen = new Set(prev?.openChangeRequests.map((r) => r.commentId) ?? []);
  for (const r of next.openChangeRequests) {
    if (!seen.has(r.commentId)) notices.push({ level: 'warning', text: `${next.ref}: ${changeRequestText(r, 200)}`, actions: ['Reply', 'Open case'] });
  }
  const before = new Map(prev?.resolutions.map((r) => [r.fingerprint, r.status]) ?? []);
  const counts = DECIDED.map((status) => [status, next.resolutions.filter((r) => r.status === status && before.get(r.fingerprint) !== status).length] as const)
    .filter(([, n]) => n > 0).map(([status, n]) => `${n} finding${n === 1 ? '' : 's'} ${status}`);
  const nowDecided = next.state === 'decided' && prev !== null && prev.state !== 'decided';
  if (counts.length > 0 || nowDecided) {
    const parts = [...(counts.length ? [`${counts.join(', ')}.`] : []), ...(nowDecided ? ['Every blocking finding is decided.'] : [])];
    notices.push({ level: 'info', text: `${next.ref}: ${parts.join(' ')}`, actions: ['Open case'] });
  }
  return notices;
}

const CLOSE_REASONS: Record<string, string> = {
  merged: 'the pull request was merged',
  pr_closed_unmerged: 'the pull request was closed without merging',
  withdrawn: 'it was withdrawn',
  closed_by_reviewer: 'a reviewer closed it',
  abandoned: 'it had no activity for 90 days',
};

export function closedNotice(ref: string, reason: string | null): string {
  return `Review case ${ref} is closed${reason && CLOSE_REASONS[reason] ? `: ${CLOSE_REASONS[reason]}` : ''}.`;
}

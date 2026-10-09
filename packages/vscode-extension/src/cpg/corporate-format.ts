// Copyright 2026 babbguy
// SPDX-License-Identifier: Apache-2.0

import type { CorporateFinding } from '@nomus/scanner';
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

export function statusText(f: Pick<CorporateFinding, 'status' | 'enforceFrom'>): string {
  switch (f.status) {
    case 'needs_review': return 'needs review';
    case 'grace': return `advisory; enforced from ${formatDay(f.enforceFrom)}`;
    case 'advisory': return 'advisory';
  }
}

/** Blocking prohibited → Error; blocking review-required → Warning; advisory and grace → Information. */
export function corporateSeverity(f: Pick<CorporateFinding, 'blocking' | 'tier'>): CorporateSeverity {
  if (!f.blocking) return 'information';
  return f.tier === 'prohibited' ? 'error' : 'warning';
}

/** `[Policy · PROHIBITED] corp.no-direct-openai v2: <message> Status: needs review.` */
export function corporateMessage(f: CorporateFinding): string {
  const message = f.rule.message.trim().replace(/[.!?]*$/, '.');
  return `[Policy · ${f.tier.toUpperCase()}] ${f.policyKey} v${f.policyVersion}: ${message} Status: ${statusText(f)}.`;
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
  id: 'blocking' | 'advisory';
  label: string;
  findings: CorporateFinding[];
}

/** Findings grouped for the view; Phase 3 findings are blocking or advisory/grace (no decisions yet). */
export function groupFindings(findings: readonly CorporateFinding[]): FindingGroup[] {
  const blocking = findings.filter((f) => f.blocking);
  const advisory = findings.filter((f) => !f.blocking);
  return [
    { id: 'blocking' as const, label: 'Blocking: needs review', findings: blocking },
    { id: 'advisory' as const, label: 'Advisory / grace period', findings: advisory },
  ].filter((g) => g.findings.length > 0);
}

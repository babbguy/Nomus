import type {
  CompileStatus, CorporateRule, CpgMe, ExampleResult, PolicyDetail, PolicyHead, PolicyState, PolicyVersion, RuleMatcher,
  Tier, VersionStatus,
} from '../api/cpg-schemas';
import { hasOrgPermission } from './cpg-permissions';

/**
 * Pure helpers for the policy registry pages (design spec §14.2): labels,
 * a plain-English reading of a compiled rule, version diffs, the four-eyes
 * status of a pending version, enforcement dates, and readable messages for
 * the registry's error codes. No React, no network.
 */

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export const TIER_LABEL: Record<Tier, string> = {
  advisory: 'Advisory',
  'review-required': 'Review required',
  prohibited: 'Prohibited',
};

export const TIER_VARIANT: Record<Tier, BadgeVariant> = {
  advisory: 'info',
  'review-required': 'warning',
  prohibited: 'danger',
};

export const TIER_DESCRIPTION: Record<Tier, string> = {
  advisory: 'Informational findings; never blocks CI and needs no review.',
  'review-required': 'Blocks CI until a reviewer from an owning board approves each finding.',
  prohibited: 'Blocks CI; needs the strictest quorum, one finding at a time (never in bulk).',
};

export const STATE_LABEL: Record<PolicyState, string> = {
  draft: 'Draft',
  proposed: 'Awaiting approval',
  active: 'Active',
  retired: 'Retired',
};

export const STATE_VARIANT: Record<PolicyState, BadgeVariant> = {
  draft: 'default',
  proposed: 'accent',
  active: 'success',
  retired: 'default',
};

export const VERSION_STATUS_LABEL: Record<VersionStatus, string> = {
  pending: 'Awaiting approval',
  active: 'Active',
  superseded: 'Superseded',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Lapsed',
  retired: 'Retired the policy',
};

export const VERSION_STATUS_VARIANT: Record<VersionStatus, BadgeVariant> = {
  pending: 'accent',
  active: 'success',
  superseded: 'default',
  rejected: 'danger',
  withdrawn: 'default',
  expired: 'warning',
  retired: 'default',
};

export const EVENT_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  approved: 'Approved (quorum reached)',
  activated: 'Activated and signed',
  superseded: 'Superseded',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn by the author',
  expired_proposal: 'Proposal lapsed',
  retired: 'Retired and signed',
};

export const COMPILE_STATUS_LABEL: Record<CompileStatus, string> = {
  compiled: 'Compiled',
  rejected_unexpressible: 'Cannot be expressed as a deterministic rule',
  rejected_schema: 'The model did not return a usable rule',
  rejected_validation: 'The rule failed validation',
  rejected_examples: 'The rule does not match your examples',
  llm_error: 'The LLM provider failed',
};

export const COMPILE_STATUS_HELP: Record<CompileStatus, string> = {
  compiled: 'The rule is valid and passes every example. It can be proposed for approval.',
  rejected_unexpressible: 'Nomus scans deterministically, so it cannot enforce judgements about intent or quality. Narrow the wording to something a code pattern can decide, or keep the policy outside Nomus.',
  rejected_schema: 'Try rephrasing the policy more concretely (which SDK, call, data or text it is about), then compile again.',
  rejected_validation: 'Every reason is listed below. Rephrase the policy and compile again.',
  rejected_examples: 'Each example is listed below with what was expected and what the rule found. Fix the examples or rephrase the policy.',
  llm_error: 'Nothing was compiled. Check the LLM provider configuration (a platform administrator manages it), then try again.',
};

/** Readable names for the rule vocabularies' values (unknown values are shown as they are). */
const SDK_NAMES: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', 'google-genai': 'Google Gen AI', cohere: 'Cohere', 'aws-bedrock': 'AWS Bedrock',
  huggingface: 'Hugging Face', replicate: 'Replicate',
};
const list = (xs: readonly string[] | undefined, names: Record<string, string> = {}): string =>
  (xs ?? []).map((x) => names[x] ?? x).join(', ') || 'none';

/** One matcher in plain English. Derived from the rule's data, not generated. */
export function describeMatcher(m: RuleMatcher): string {
  switch (m.kind) {
    case 'sdk_call':
      return m.methods && m.methods.length > 0
        ? `a call to ${list(m.methods)} of the ${list(m.sdks, SDK_NAMES)} SDK`
        : `any call through the ${list(m.sdks, SDK_NAMES)} SDK`;
    case 'sdk_import':
      return `an import of the ${list(m.sdks, SDK_NAMES)} SDK`;
    case 'capability':
      return `code with the capability ${list(m.capabilities)}`;
    case 'data_pattern':
      return m.labels && m.labels.length > 0
        ? `data of the kind ${list(m.labels)} (${list(m.categories)})`
        : `data in the category ${list(m.categories)}`;
    case 'data_flow': {
      const parts: string[] = [];
      if (m.sources && m.sources.length > 0) parts.push(`from ${list(m.sources)}`);
      if (m.sinks && m.sinks.length > 0) parts.push(`into ${list(m.sinks)}`);
      return `a data flow ${parts.join(' ') || 'of any kind'}`;
    }
    case 'line_regex':
      return `a line matching the pattern /${m.pattern.source}/${m.pattern.flags}${m.pattern.ignoreComments ? ' (comments ignored)' : ''}`;
  }
}

/** The compiled rule as plain-English lines, deterministically derived from its data. */
export function describeRule(rule: CorporateRule): string[] {
  const lines: string[] = [];
  const [anchor, ...rest] = rule.match.all;
  lines.push(`Flags ${describeMatcher(anchor)}.`);
  if (rest.length > 0) {
    const where = rule.match.withinLines === null ? 'anywhere in the same file' : `within ${rule.match.withinLines} line${rule.match.withinLines === 1 ? '' : 's'}`;
    lines.push(`Only when ${where} there is also ${rest.map(describeMatcher).join(', and ')}.`);
  }
  if (rule.match.unless.length > 0) {
    const where = rule.match.unlessScope === 'window' && rule.match.withinLines !== null ? `within ${rule.match.withinLines} lines` : 'anywhere in the same file';
    lines.push(`Not when ${where} there is ${rule.match.unless.map(describeMatcher).join(', or ')}.`);
  }
  lines.push(`Applies to files matching ${rule.files.include.join(', ')}${rule.files.exclude.length > 0 ? `, except ${rule.files.exclude.join(', ')}` : ''}.`);
  if (rule.files.languages && rule.files.languages.length > 0) lines.push(`Languages: ${rule.files.languages.join(', ')}.`);
  lines.push(`Developers see: "${rule.message}"`);
  return lines;
}

/** Leaf-level differences between two JSON values (mirrors the engine's jsonDiff). */
export function jsonDiff(before: unknown, after: unknown, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => jsonDiff(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.flatMap((b, i) => jsonDiff(b, after[i], `${path}[${i}]`));
  }
  return stableJson(before) === stableJson(after) ? [] : [{ path: path || '(root)', before: before ?? null, after: after ?? null }];
}

function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(sort(v) ?? null);
}

/** A value of a diff row as one line of text. */
export function diffValue(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return v === '' ? '(empty)' : v;
  return JSON.stringify(v);
}

export interface VersionDiffRow {
  field: string;
  before: string;
  after: string;
}

/** Everything that differs between two versions of a policy, field by field. */
export function versionDiff(a: PolicyVersion, b: PolicyVersion): VersionDiffRow[] {
  const rows: VersionDiffRow[] = [];
  const push = (field: string, x: unknown, y: unknown) => {
    if (stableJson(x) !== stableJson(y)) rows.push({ field, before: diffValue(x), after: diffValue(y) });
  };
  push('Kind', a.kind === 'retire' ? 'Retirement' : 'Definition', b.kind === 'retire' ? 'Retirement' : 'Definition');
  push('Title', a.title, b.title);
  push('Tier', TIER_LABEL[a.tier], TIER_LABEL[b.tier]);
  push('Owning boards', a.owningBoards.map((x) => x.name || x.id).sort().join(', '), b.owningBoards.map((x) => x.name || x.id).sort().join(', '));
  push(a.kind === 'retire' || b.kind === 'retire' ? 'Policy text or retirement reason' : 'Policy text', a.plainText, b.plainText);
  push('Grace period (days)', a.graceDays, b.graceDays);
  push('Requested enforce-from', a.enforceFromRequested, b.enforceFromRequested);
  for (const d of jsonDiff(a.rule, b.rule)) {
    rows.push({ field: `Rule ${d.path === '(root)' ? '' : d.path}`.trim(), before: diffValue(d.before), after: diffValue(d.after) });
  }
  return rows;
}

/** `user:<uuid>` → the uuid; anything else → null. */
export function userIdOf(actor: string): string | null {
  return actor.startsWith('user:') ? actor.slice('user:'.length) : null;
}

export interface FourEyes {
  version: PolicyVersion;
  approvals: number;
  required: number;
  rejected: boolean;
  /** `user:<id>` of the author and of the compile requester (null for a retirement). */
  author: string;
  requester: string | null;
  /** What the signed-in user may do, and why not when they may not vote. */
  canVote: boolean;
  canWithdraw: boolean;
  voteBlockedReason: string | null;
  myVote: 'approve' | 'reject' | null;
}

/**
 * The four-eyes status of a policy's pending version for the signed-in user.
 * It mirrors the server's rules so the page offers only what the server
 * accepts: policy.approve, not the author, not the compile requester, one
 * vote per person. The server checks all of this again on every vote.
 */
export function fourEyesStatus(detail: PolicyDetail, me: CpgMe | null): FourEyes | null {
  const version = detail.versions.find((v) => v.id === detail.policy.pendingVersionId);
  if (!version) return null;
  const votes = detail.votes.filter((v) => v.versionId === version.id);
  const requester = version.compileRecordId ? detail.compileRecords.find((r) => r.id === version.compileRecordId)?.requestedBy ?? null : null;
  const self = me ? `user:${me.user.id}` : null;
  const mine = me ? votes.find((v) => v.voterUserId === me.user.id) : undefined;
  let reason: string | null = null;
  if (!me) reason = 'Your permissions are still loading.';
  else if (!hasOrgPermission(me, 'policy.approve')) reason = 'Voting needs the policy.approve permission (the Policy Approver role).';
  else if (self === version.createdBy) reason = 'You proposed this version, so you cannot approve or reject it. Four-eyes: someone else must decide.';
  else if (self !== null && self === requester) reason = 'You compiled this rule, so you cannot approve or reject it. Four-eyes: someone else must decide.';
  else if (mine) reason = `You already voted (${mine.vote}).`;
  return {
    version,
    approvals: votes.filter((v) => v.vote === 'approve').length,
    required: detail.requiredApprovals,
    rejected: votes.some((v) => v.vote === 'reject'),
    author: version.createdBy,
    requester,
    canVote: reason === null,
    canWithdraw: !!self && self === version.createdBy,
    voteBlockedReason: reason,
    myVote: mine?.vote ?? null,
  };
}

/** An instant in UTC, unambiguous for every reader: "Oct 22, 2026, 09:00 UTC". */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

/** A date in UTC: "Oct 22, 2026". */
export function formatUtcDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Whole days from `now` until `iso`, rounded up; null when not a valid date. */
export function daysUntil(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}

/** How a policy is enforced right now, for the list and the detail header. */
export function enforcementSummary(head: Pick<PolicyHead, 'state' | 'enforceFrom' | 'inGracePeriod' | 'tier'>, now: number): { label: string; variant: BadgeVariant; detail: string } {
  if (head.state === 'retired') return { label: 'Retired', variant: 'default', detail: 'No longer scanned.' };
  if (head.state !== 'active' || !head.enforceFrom) return { label: 'Not active', variant: 'default', detail: 'Nothing is scanned until a version is approved.' };
  if (head.tier === 'advisory') return { label: 'Advisory', variant: 'info', detail: `Active since ${formatUtc(head.enforceFrom)}; advisory findings never block.` };
  if (head.inGracePeriod) {
    const days = daysUntil(head.enforceFrom, now);
    return {
      label: 'Grace period',
      variant: 'warning',
      detail: `Advisory until ${formatUtc(head.enforceFrom)}${days !== null ? ` (${days} day${days === 1 ? '' : 's'})` : ''}, then enforced.`,
    };
  }
  return { label: 'Enforced', variant: 'success', detail: `Enforced since ${formatUtc(head.enforceFrom)}.` };
}

/** The example results of a compile record as readable lines. */
export function exampleResultLine(r: ExampleResult): string {
  const which = `${r.kind === 'violating' ? 'Violating' : 'Compliant'} example ${r.index + 1} (${r.path})`;
  const found = r.findings === 0 ? 'no finding' : `${r.findings} finding${r.findings === 1 ? '' : 's'}${r.lines.length > 0 ? ` on line${r.lines.length === 1 ? '' : 's'} ${r.lines.join(', ')}` : ''}`;
  const expected = r.expected === 'finding' ? 'expected at least one finding' : 'expected no finding';
  return `${which}: ${r.passed ? 'passed' : 'FAILED'}, ${expected}, got ${found}.${r.note ? ` ${r.note}` : ''}`;
}

/** Readable text for the registry's error codes, including their details (reasons, examples, ids). */
export function policyErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.name === 'CpgContractError') return err.message;
  const data = (err as { response?: { status?: number; data?: { error?: unknown; code?: unknown; details?: unknown } } } | null)?.response?.data;
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  const message = typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
  const code = typeof data?.code === 'string' ? data.code : null;
  const details = data?.details;
  const extra: string[] = [];
  if (Array.isArray(details)) {
    for (const d of details) {
      const issue = d as { path?: unknown; message?: unknown };
      const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
      if (typeof issue.message === 'string') extra.push(path ? `${path}: ${issue.message}` : issue.message);
    }
  } else if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>;
    if (Array.isArray(d.reasons)) extra.push(...d.reasons.filter((x): x is string => typeof x === 'string'));
    if (Array.isArray(d.exampleResults)) {
      for (const r of d.exampleResults as ExampleResult[]) if (r && typeof r === 'object' && 'passed' in r && !r.passed) extra.push(exampleResultLine(r));
    }
    if (Array.isArray(d.policyKeys)) extra.push(`Policies: ${d.policyKeys.join(', ')}`);
    if (Array.isArray(d.boardIds)) extra.push(`Boards: ${d.boardIds.join(', ')}`);
    if (Array.isArray(d.policyIds)) extra.push(`Policies: ${d.policyIds.join(', ')}`);
  }
  const prefix = code === 'self_approval_forbidden' ? 'Refused (four-eyes): ' : '';
  const text = `${prefix}${message}${extra.length > 0 ? `: ${extra.join('; ')}` : ''}`;
  if (!code && typeof status === 'number' && status >= 500) return `${fallback} (server error ${status}). Try again; if it keeps failing, check the engine logs.`;
  return text;
}

// ─── The user card's role label (brief §9) ─────────────────────────────

/** System roles from the most to the least privileged. Custom roles rank after them. */
const ROLE_RANK = ['org_admin', 'exception_approver', 'policy_approver', 'case_reviewer', 'policy_author', 'auditor', 'developer'];

/**
 * The label under the user's name in the sidebar. Platform administrators
 * and users without governance roles keep the legacy label; a user with
 * governance roles sees the most privileged one, plus "+N" for the others.
 */
export function userRoleLabel(legacyRole: string | undefined, me: Pick<CpgMe, 'roles' | 'isPlatformAdmin'> | null): string {
  if (legacyRole === 'platform_admin') return 'Admin';
  const roles = me && !me.isPlatformAdmin ? me.roles : [];
  if (roles.length === 0) return 'Member';
  const rank = (r: { key: string; isSystem: boolean }) => {
    const i = r.isSystem ? ROLE_RANK.indexOf(r.key) : -1;
    return i === -1 ? ROLE_RANK.length : i;
  };
  const sorted = [...roles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return sorted.length === 1 ? sorted[0].name : `${sorted[0].name} +${sorted.length - 1}`;
}

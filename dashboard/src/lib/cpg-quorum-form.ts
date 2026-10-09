import type { z } from 'zod';
import { quorumConfigSchema, type QuorumConfig, type QuorumScope, type ScopeRule, type ScopeSlot } from '../api/cpg-quorum';
import { jsonDiff, diffValue } from './cpg-policy';

/**
 * Pure helpers for the quorum editor: validation with the engine's own
 * rules (cpg-quorum.ts mirrors them), readable field names, immutable
 * updates, and the change list shown before saving.
 */

export type EditableTier = 'review-required' | 'prohibited';
export const EDITABLE_TIERS: readonly EditableTier[] = ['review-required', 'prohibited'];

export const SCOPE_LABEL: Record<QuorumScope, string> = {
  snippet: 'One finding (snippet)',
  bulk: 'Many findings at once (bulk)',
  standing: 'Standing exception (future code)',
};

const FIELD_LABEL: Record<string, string> = {
  approvals: 'Approvals',
  boardCoverage: 'Board coverage',
  extraBoardIds: 'Extra required boards',
  requiredPermission: 'Required permission',
  maxExpiryDays: 'Maximum expiry (days)',
  defaultExpiryDays: 'Default expiry (days)',
  allowed: 'Allowed',
  allowOrgWideRepoPatterns: 'Allow organization-wide repository patterns',
  newPolicyDefaultDays: 'New policy grace (days)',
  newVersionDefaultDays: 'New version grace (days)',
  proposalLapseDays: 'Proposal lapses after (days)',
};

const TIER_NAME: Record<string, string> = { 'review-required': 'Review required', prohibited: 'Prohibited', advisory: 'Advisory' };

/** A config path ("tiers.prohibited.snippet.approvals") as words. */
export function pathLabel(path: string, policyNames: ReadonlyMap<string, string> = new Map()): string {
  const parts = path.split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'tiers' || p === 'schemaVersion') continue;
    if (p === 'policyOverrides' && parts[i + 1]) { out.push(`Override for ${policyNames.get(parts[i + 1]) ?? parts[i + 1]}`); i++; continue; }
    if (p === 'policyApproval') { out.push('Policy approval'); continue; }
    if (p === 'standingExceptions') { out.push('Standing exceptions'); continue; }
    if (p === 'gracePeriod') { out.push('Grace period'); continue; }
    out.push(TIER_NAME[p] ?? (p in SCOPE_LABEL ? SCOPE_LABEL[p as QuorumScope] : FIELD_LABEL[p] ?? p));
  }
  return out.join(' · ') || 'Configuration';
}

export interface QuorumIssue {
  path: string;
  message: string;
}

/** Flatten zod issues; a union (a scope slot) reports the branch the slot claims (`allowed` true or false). */
function flatten(issues: z.ZodIssue[]): QuorumIssue[] {
  const out: QuorumIssue[] = [];
  for (const issue of issues) {
    if (issue.code === 'invalid_union') {
      const branches = issue.unionErrors.map((e) => e.issues);
      const relevant = branches.find((b) => !b.some((i) => i.path[i.path.length - 1] === 'allowed')) ?? branches[0] ?? [];
      out.push(...flatten(relevant));
      continue;
    }
    out.push({ path: issue.path.join('.'), message: issue.message });
  }
  return out;
}

/** Every problem with a draft config, as the engine's schema reports them. Empty when it is valid. */
export function quorumIssues(config: unknown): QuorumIssue[] {
  const parsed = quorumConfigSchema.safeParse(config);
  if (parsed.success) return [];
  const seen = new Set<string>();
  return flatten(parsed.error.issues).filter((i) => {
    const k = `${i.path}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Set a value at a dotted path, returning a new config (inputs are never mutated). */
export function setAt<T>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const src = (obj ?? {}) as Record<string, unknown>;
  return { ...src, [head]: setAt(src[head], rest, value) } as T;
}

/** Remove a key at a dotted path, returning a new object. */
export function removeAt<T>(obj: T, path: string[]): T {
  const [head, ...rest] = path;
  const src = { ...(obj as Record<string, unknown>) };
  if (rest.length === 0) delete src[head];
  else src[head] = removeAt(src[head], rest);
  return src as T;
}

/** A slot switched on gets a full rule (copied from `template` when it is one); switched off is `{ allowed: false }`. */
export function toggledSlot(on: boolean, template: ScopeSlot | undefined): ScopeSlot {
  if (!on) return { allowed: false };
  if (template && template.allowed) return { ...template };
  const rule: ScopeRule = { allowed: true, approvals: 1, boardCoverage: 'any_owning', extraBoardIds: [], requiredPermission: null, maxExpiryDays: 90, defaultExpiryDays: 30 };
  return rule;
}

/** The changes a draft makes to the config in force, as readable rows. */
export function quorumChanges(before: QuorumConfig, after: QuorumConfig, policyNames: ReadonlyMap<string, string> = new Map()): Array<{ field: string; before: string; after: string }> {
  return jsonDiff(before, after).map((d) => ({
    field: pathLabel(d.path.replace(/\[(\d+)\]/g, '.$1'), policyNames),
    before: diffValue(d.before),
    after: diffValue(d.after),
  }));
}

/** One-line summary of a scope slot for the read-only view. */
export function slotSummary(slot: ScopeSlot | undefined, boardNames: ReadonlyMap<string, string> = new Map()): string {
  if (!slot) return 'Tier default';
  if (!slot.allowed) return 'Not allowed';
  const parts = [
    `${slot.approvals} approval${slot.approvals === 1 ? '' : 's'}`,
    slot.boardCoverage === 'all_owning' ? 'one from each owning board' : 'from any owning board',
  ];
  if (slot.extraBoardIds.length > 0) parts.push(`also required: ${slot.extraBoardIds.map((id) => boardNames.get(id) ?? id).join(', ')}`);
  if (slot.requiredPermission) parts.push(`one approver needs ${slot.requiredPermission}`);
  parts.push(`expiry up to ${slot.maxExpiryDays} days (default ${slot.defaultExpiryDays})`);
  return parts.join('; ');
}

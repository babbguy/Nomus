import type { AdminRule, RuleDraft, RuleEffect, RuleSeverity } from '../../../api/rules';

/** Form state for creating or editing a rule. Everything is a string/primitive the inputs can bind to. */
export interface RuleFormState {
  sourceId: string;
  ruleKey: string;
  jurisdiction: string;
  category: string;
  /** JSON object text: { "action": "text_generation", ... } */
  conditionsText: string;
  effect: RuleEffect;
  severity: RuleSeverity;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string;
  /** Comma-separated */
  industriesText: string;
  industryScope: string;
  industryNotes: string;
}

export const RULE_KEY_RE = /^[a-z][a-z0-9_.]{2,127}$/;
export const JURISDICTION_RE = /^[A-Z0-9-]{1,16}$/;
const CONDITION_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyRuleForm(sourceId = '', jurisdiction = ''): RuleFormState {
  return {
    sourceId,
    ruleKey: '',
    jurisdiction,
    category: 'transparency',
    conditionsText: '{\n  "action": ""\n}',
    effect: 'flag',
    severity: 'medium',
    humanSummary: '',
    legalReference: '',
    effectiveDate: new Date().toISOString().slice(0, 10),
    expiresAt: '',
    industriesText: 'all',
    industryScope: 'global',
    industryNotes: '',
  };
}

export function formFromRule(rule: AdminRule): RuleFormState {
  return {
    sourceId: rule.sourceId,
    ruleKey: rule.ruleKey,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditionsText: JSON.stringify(rule.conditions, null, 2),
    effect: rule.effect,
    severity: rule.severity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
    effectiveDate: rule.effectiveDate.slice(0, 10),
    expiresAt: rule.expiresAt ? rule.expiresAt.slice(0, 10) : '',
    industriesText: rule.industries.join(', '),
    industryScope: rule.industryScope,
    industryNotes: rule.industryNotes,
  };
}

export type ConditionsParse =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

/**
 * Parse and validate the conditions editor. Evaluation compares every value to
 * the same-named context key with strict string equality and ignores empty
 * values, so only non-empty string values are accepted.
 */
export function parseConditions(text: string): ConditionsParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Conditions must be a JSON object, e.g. {"action": "text_generation"}' };
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, error: 'Add at least one condition' };
  if (entries.length > 20) return { ok: false, error: 'At most 20 conditions are allowed' };
  for (const [key, value] of entries) {
    if (!CONDITION_KEY_RE.test(key)) {
      return { ok: false, error: `Condition key "${key}" must be a plain identifier (letters, digits, "_")` };
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, error: `Condition "${key}" must be a non-empty string` };
    }
    if (value.length > 256) return { ok: false, error: `Condition "${key}" is longer than 256 characters` };
  }
  return { ok: true, value: Object.fromEntries(entries.map(([k, v]) => [k, (v as string).trim()])) };
}

export function parseIndustries(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Client-side checks that mirror the server schema. The server stays authoritative. */
export function validateRuleForm(form: RuleFormState, mode: 'create' | 'edit'): string[] {
  const errors: string[] = [];
  if (mode === 'create') {
    if (!form.sourceId) errors.push('Choose a source.');
    if (!RULE_KEY_RE.test(form.ruleKey)) {
      errors.push('Rule key must be 3-128 characters: lowercase letters, digits, "_" or ".", starting with a letter.');
    }
  }
  if (form.jurisdiction && !JURISDICTION_RE.test(form.jurisdiction.trim().toUpperCase())) {
    errors.push('Jurisdiction must be 1-16 characters: letters, digits or "-".');
  }
  const conditions = parseConditions(form.conditionsText);
  if (!conditions.ok) errors.push(conditions.error);
  if (form.humanSummary.trim().length < 10) errors.push('Summary must be at least 10 characters.');
  if (form.legalReference.trim().length < 3) errors.push('Legal reference is required.');
  if (!DATE_RE.test(form.effectiveDate)) errors.push('Effective date is required (YYYY-MM-DD).');
  if (form.expiresAt && form.effectiveDate && form.expiresAt <= form.effectiveDate) {
    errors.push('Expiry must be after the effective date.');
  }
  if (parseIndustries(form.industriesText).length === 0) {
    errors.push('List at least one industry (use "all" for every industry).');
  }
  return errors;
}

/** Body for creating a rule. Call only after validateRuleForm returns no errors. */
export function buildCreatePayload(form: RuleFormState): RuleDraft & { sourceId: string; ruleKey: string } {
  const conditions = parseConditions(form.conditionsText);
  if (!conditions.ok) throw new Error(conditions.error);
  return {
    sourceId: form.sourceId,
    ruleKey: form.ruleKey,
    ...(form.jurisdiction.trim() ? { jurisdiction: form.jurisdiction.trim().toUpperCase() } : {}),
    category: form.category,
    conditions: conditions.value,
    effect: form.effect,
    severity: form.severity,
    humanSummary: form.humanSummary.trim(),
    legalReference: form.legalReference.trim(),
    effectiveDate: form.effectiveDate,
    expiresAt: form.expiresAt || null,
    industries: parseIndustries(form.industriesText),
    industryScope: form.industryScope,
    industryNotes: form.industryNotes,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortedEntries = (o: Record<string, string>) =>
  Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * Only the fields that differ from the stored rule. Sending nothing for an
 * untouched field matters: every accepted edit bumps the rule's version.
 */
export function buildPatch(form: RuleFormState, original: AdminRule): Partial<RuleDraft> {
  const conditions = parseConditions(form.conditionsText);
  if (!conditions.ok) throw new Error(conditions.error);
  const patch: Partial<RuleDraft> = {};
  const jurisdiction = form.jurisdiction.trim().toUpperCase();
  if (jurisdiction && jurisdiction !== original.jurisdiction) patch.jurisdiction = jurisdiction;
  if (form.category !== original.category) patch.category = form.category;
  if (!sameJson(sortedEntries(conditions.value), sortedEntries(original.conditions))) patch.conditions = conditions.value;
  if (form.effect !== original.effect) patch.effect = form.effect;
  if (form.severity !== original.severity) patch.severity = form.severity;
  if (form.humanSummary.trim() !== original.humanSummary) patch.humanSummary = form.humanSummary.trim();
  if (form.legalReference.trim() !== original.legalReference) patch.legalReference = form.legalReference.trim();
  // The date input shows only the date part; an untouched datetime stays as stored.
  if (form.effectiveDate !== original.effectiveDate.slice(0, 10)) patch.effectiveDate = form.effectiveDate;
  const originalExpiry = original.expiresAt ? original.expiresAt.slice(0, 10) : '';
  if (form.expiresAt !== originalExpiry) patch.expiresAt = form.expiresAt || null;
  const industries = parseIndustries(form.industriesText);
  if (!sameJson(industries, original.industries)) patch.industries = industries;
  if (form.industryScope !== original.industryScope) patch.industryScope = form.industryScope;
  if (form.industryNotes !== original.industryNotes) patch.industryNotes = form.industryNotes;
  return patch;
}

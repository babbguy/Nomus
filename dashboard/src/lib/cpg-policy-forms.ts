import { corporateRuleSchema, type CodeExample } from '../api/cpg';

/**
 * Client-side checks for the policy authoring form. The server applies the
 * same limits (and more) on every request; these only let the author see
 * problems before sending.
 */

const MAX_CODE = 16384;

export function compileInputProblems(plainText: string, violating: CodeExample[], compliant: CodeExample[]): string[] {
  const problems: string[] = [];
  const text = plainText.trim();
  if (text.length < 20) problems.push('Describe the policy in at least 20 characters.');
  if (text.length > 8000) problems.push('The policy text is longer than 8,000 characters.');
  if (violating.length < 1) problems.push('Add at least one violating example.');
  if (violating.length > 10 || compliant.length > 10) problems.push('At most 10 examples of each kind.');
  [...violating.map((e, i) => ['Violating', i, e] as const), ...compliant.map((e, i) => ['Compliant', i, e] as const)].forEach(([kind, i, e]) => {
    if (!e.path.trim()) problems.push(`${kind} example ${i + 1}: give a file path (for example src/app/chat.ts).`);
    else if (e.path.length > 300) problems.push(`${kind} example ${i + 1}: the path is longer than 300 characters.`);
    if (!e.code.trim()) problems.push(`${kind} example ${i + 1}: paste the code.`);
    else if (e.code.length > MAX_CODE) problems.push(`${kind} example ${i + 1}: the code is longer than 16 KiB.`);
  });
  return problems;
}

/** Problems with an edited rule as typed: JSON syntax and structure (the server also checks vocabularies, regex safety and globs). */
export function ruleEditProblems(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return [`Not valid JSON: ${(err as Error).message}`];
  }
  const parsed = corporateRuleSchema.safeParse(value);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `rule${i.path.length ? `.${i.path.join('.')}` : ''}: ${i.message}`);
}

export type GraceMode = 'default' | 'days' | 'date';

/**
 * The grace fields of a proposal. The quorum default sends neither field,
 * so the server applies its default when the version is approved (14 days
 * for a new policy, 0 for a new version, by default); never a 0 of our own.
 */
export function graceFields(mode: GraceMode, daysText: string, date: string): { graceDays?: number; enforceFrom?: string } {
  if (mode === 'days') return { graceDays: Number(daysText) };
  if (mode === 'date') return { enforceFrom: `${date}T00:00:00.000Z` };
  return {};
}

/** Tomorrow (UTC) as YYYY-MM-DD: the earliest enforce-from date that is not in the past. */
export function tomorrowUtc(now: number): string {
  return new Date(now + 86_400_000).toISOString().slice(0, 10);
}

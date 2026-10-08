import { signData } from './signing.js';

/**
 * Produce a deterministic canonical JSON string for signing.
 * Keys sorted alphabetically at every level, no whitespace.
 */
export function canonicalJSON(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compile a policy rule into a signed, wire-ready format.
 */
export function compilePolicy(rule: {
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: string;
  conditions: string;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
}) {
  const canonical = canonicalJSON({
    ruleKey: rule.ruleKey,
    version: rule.version,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditions: JSON.parse(rule.conditions),
    effect: rule.effect,
    severity: rule.severity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
  });

  const signature = signData(canonical);

  return {
    ruleKey: rule.ruleKey,
    version: rule.version,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditions: JSON.parse(rule.conditions),
    effect: rule.effect,
    severity: rule.severity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
    signature,
  };
}

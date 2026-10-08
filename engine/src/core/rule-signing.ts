/**
 * Canonical signing for policy rules.
 *
 * A rule's signature covers exactly the fields below. Every code path that
 * writes a rule (seeding, the extraction pipeline, the forge worker, manual
 * edits) must sign through this module, and the integrity check verifies
 * through it, so a rule written by one path always verifies in the other.
 */
import { canonicalJSON } from './policy-compiler.js';
import { signData, verifySignature } from './signing.js';

/** Placeholder written by seeders before signing keys are applied. */
export const UNSIGNED = 'unsigned';

export interface SignableRule {
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: string;
  /** JSON string as stored in the database, or the parsed object. */
  conditions: string | Record<string, unknown> | unknown[];
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
}

export function ruleSignaturePayload(rule: SignableRule): string {
  return canonicalJSON({
    ruleKey: rule.ruleKey,
    version: rule.version,
    jurisdiction: rule.jurisdiction,
    category: rule.category,
    conditions: typeof rule.conditions === 'string' ? JSON.parse(rule.conditions) : rule.conditions,
    effect: rule.effect,
    severity: rule.severity,
    humanSummary: rule.humanSummary,
    legalReference: rule.legalReference,
  });
}

export function signRule(rule: SignableRule): string {
  return signData(ruleSignaturePayload(rule));
}

export function verifyRuleSignature(rule: SignableRule & { signature: string }): boolean {
  return verifySignature(ruleSignaturePayload(rule), rule.signature);
}

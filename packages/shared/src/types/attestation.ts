import type { PolicyConditions, PolicyEffect } from './policy.js';

export type AttestationResult = 'compliant' | 'non_compliant' | 'requires_review';
/** @deprecated Use 'obligations_clear' | 'obligations_identified' | 'requires_review' for v2 — kept for API backward compat */

export interface EvaluatedRule {
  ruleKey: string;
  version: number;
  effect: PolicyEffect;
  matched: boolean;
}

export interface AttestationReceipt {
  id: string;
  orgId: string;
  actionContext: PolicyConditions;
  rulesEvaluated: EvaluatedRule[];
  result: AttestationResult;
  jurisdiction: string;
  policyStateHash: string;
  signature: string;
  evaluatedAt: string;
}

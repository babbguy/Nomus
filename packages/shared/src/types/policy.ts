export type PolicyEffect =
  | 'deny'
  | 'allow_with_audit'
  | 'require_disclosure'
  | 'flag';

export type PolicySeverity = 'critical' | 'high' | 'medium' | 'low';

export type PolicyCategory =
  | 'data_governance'
  | 'transparency'
  | 'risk_assessment'
  | 'human_oversight'
  | 'accountability'
  | 'fairness'
  | 'privacy'
  | 'safety'
  | 'security'
  | 'intellectual_property';

export interface PolicyConditions {
  action?: string;
  risk_level?: string;
  region?: string;
  data_type?: string;
  model_type?: string;
  sector?: string;
  [key: string]: string | undefined;
}

export interface PolicyRule {
  id: string;
  sourceId: string;
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: PolicyCategory;
  conditions: PolicyConditions;
  effect: PolicyEffect;
  severity: PolicySeverity;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  isActive: boolean;
  signature: string;
  createdAt: string;
  updatedAt: string;
}

export interface CompiledPolicy {
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: PolicyCategory;
  conditions: PolicyConditions;
  effect: PolicyEffect;
  severity: PolicySeverity;
  humanSummary: string;
  legalReference: string;
  signature: string;
}

export interface PolicyBundle {
  policies: CompiledPolicy[];
  stateHash: string;
  generatedAt: string;
  signature: string;
}

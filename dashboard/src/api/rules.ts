import api from './client';

export type RuleEffect = 'deny' | 'allow_with_audit' | 'require_disclosure' | 'flag';
export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low';

export const RULE_CATEGORIES = [
  'data_governance', 'transparency', 'risk_assessment', 'human_oversight', 'accountability',
  'fairness', 'privacy', 'safety', 'security', 'intellectual_property',
] as const;

export const RULE_EFFECTS: RuleEffect[] = ['deny', 'allow_with_audit', 'require_disclosure', 'flag'];
export const RULE_SEVERITIES: RuleSeverity[] = ['critical', 'high', 'medium', 'low'];
export const RULE_INDUSTRY_SCOPES = ['global', 'sector_specific', 'subsector_specific'] as const;

export interface AdminRule {
  id: string;
  sourceId: string;
  sourceName?: string | null;
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: RuleEffect;
  severity: RuleSeverity;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  industries: string[];
  industryScope: string;
  industryNotes: string;
  isActive: boolean;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuleHistoryEntry {
  id: string;
  eventType: 'policy.created' | 'policy.updated' | 'policy.revoked' | 'conflict.detected';
  sequence: number;
  createdAt: string;
  payload: {
    version?: number;
    actor?: string;
    reason?: string;
    reactivated?: boolean;
    manual?: boolean;
    changedFields?: string[];
  } | null;
}

export type AdminRuleDetail = AdminRule & { history: RuleHistoryEntry[] };

/** Fields an admin supplies when creating or editing a rule. */
export interface RuleDraft {
  ruleKey?: string;
  sourceId?: string;
  jurisdiction?: string;
  category: string;
  conditions: Record<string, string>;
  effect: RuleEffect;
  severity: RuleSeverity;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  expiresAt: string | null;
  industries: string[];
  industryScope: string;
  industryNotes: string;
}

export interface ListRulesParams {
  sourceId?: string;
  jurisdiction?: string;
  includeInactive?: boolean;
  limit?: number;
  offset?: number;
}

export async function listRules(params: ListRulesParams = {}): Promise<{ count: number; total: number; limit: number; offset: number; rules: AdminRule[] }> {
  const { data } = await api.get('/admin/rules', { params });
  return data;
}

export async function getRule(id: string): Promise<AdminRuleDetail> {
  const { data } = await api.get(`/admin/rules/${id}`);
  return data;
}

export async function createRule(draft: RuleDraft & { sourceId: string; ruleKey: string }): Promise<AdminRule> {
  const { data } = await api.post('/admin/rules', draft);
  return data;
}

export async function updateRule(id: string, patch: Partial<RuleDraft> & { locked?: boolean }): Promise<AdminRule & { changed: boolean }> {
  const { data } = await api.patch(`/admin/rules/${id}`, patch);
  return data;
}

export async function retireRule(id: string): Promise<AdminRule> {
  const { data } = await api.post(`/admin/rules/${id}/retire`);
  return data;
}

export async function reactivateRule(id: string): Promise<AdminRule> {
  const { data } = await api.post(`/admin/rules/${id}/reactivate`);
  return data;
}

import api from './client';

export interface Policy {
  id: string;
  ruleKey: string;
  version: number;
  jurisdiction: string;
  category: string;
  conditions: Record<string, string>;
  effect: string;
  severity: string;
  humanSummary: string;
  legalReference: string;
  effectiveDate: string;
  industries: string[];
  industryScope: string;
  industryNotes: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IndustrySummary {
  name: string;
  ruleCount: number;
  jurisdictions: string[];
  severities: Record<string, number>;
}

export async function getPolicies(params?: {
  jurisdiction?: string;
  category?: string;
  industry?: string;
  since?: string;
}): Promise<{ count: number; policies: Policy[] }> {
  const { data } = await api.get('/policies', { params });
  return data;
}

export async function getPolicy(id: string): Promise<Policy> {
  const { data } = await api.get(`/policies/${id}`);
  return data;
}

export async function getIndustries(): Promise<{ industries: IndustrySummary[]; totalRules: number }> {
  const { data } = await api.get('/policies/industries');
  return data;
}

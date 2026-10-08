import api from './client';

export interface SimulateInput {
  capabilities: string[];
  dataTypes: string[];
  targetMarkets: string[];
  modelType?: string;
  sector?: string;
}

export interface MarketReport {
  jurisdiction: string;
  totalRules: number;
  triggered: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low' | 'none';
  rules: Array<{
    ruleKey: string;
    effect: string;
    severity: string;
    humanSummary: string;
    legalReference: string;
    matchedOn: string[];
  }>;
}

export interface SimulateResult {
  input: SimulateInput;
  markets: Record<string, MarketReport>;
  conflicts: Array<{ jurisdictionA: string; jurisdictionB: string; description: string }>;
  gapAnalysis: { allJurisdictionsCovered: boolean; uncoveredMarkets: string[] };
  overallRisk: string;
  totalRulesTriggered: number;
}

export async function runSimulation(input: SimulateInput): Promise<SimulateResult> {
  const { data } = await api.post('/simulate', input);
  return data;
}

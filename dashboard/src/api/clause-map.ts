import api from './client';

export type ClauseFramework = 'EU_AI_ACT' | 'HIPAA' | 'GDPR';

export interface ClauseMapping {
  id: string;
  mappingKey: string;
  datasetVersion: number;
  heuristicLabel: string;
  heuristic: { requires: Array<{ capability: string; anyOf?: string[]; detector?: string }>; maxLineDistance?: number };
  framework: ClauseFramework;
  clauseCitation: string;
  clauseTitle: string;
  clauseUrl: string | null;
  rationale: string;
  posterior: number;
  priorMean: number;
  observations: number;
  firedCount: number;
  evaluatedCount: number;
  orgMatches: { total: number; open: number; confirmed: number; dismissed: number };
  updatedAt: string;
}

export interface ClauseMatch {
  id: string;
  repo: string;
  commitSha: string;
  filePath: string;
  lineNumber: number;
  evidence: Array<{ findingId: string; capability: string; detector: string | null; line: number; severity: string }>;
  confidence: number;
  livePosterior: number;
  status: 'open' | 'confirmed' | 'dismissed';
  matchedAt: string;
  resolvedAt: string | null;
  mapping: {
    id: string;
    mappingKey: string;
    heuristicLabel: string;
    framework: ClauseFramework;
    clauseCitation: string;
    clauseTitle: string;
    clauseUrl: string | null;
    rationale: string;
  };
}

export interface LearningEvent {
  eventType: string;
  posteriorBefore: number;
  posteriorAfter: number;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function getClauseMappings() {
  const { data } = await api.get('/clause-map/mappings');
  return data as { count: number; mappings: ClauseMapping[] };
}

export async function getClauseMatches(params?: Record<string, string>) {
  const { data } = await api.get('/clause-map/matches', { params });
  return data as { count: number; matches: ClauseMatch[] };
}

export async function getMappingHistory(mappingId: string) {
  const { data } = await api.get(`/clause-map/mappings/${mappingId}/history`);
  return data as { count: number; events: LearningEvent[] };
}

export async function submitClauseFeedback(matchId: string, verdict: 'confirm' | 'dismiss', note?: string) {
  const { data } = await api.post(`/clause-map/matches/${matchId}/feedback`, { verdict, note });
  return data as { matchId: string; mappingKey: string; status: string; posteriorBefore: number; posteriorAfter: number };
}

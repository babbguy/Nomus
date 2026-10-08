import api from './client';

export async function triggerScrape(sourceId: string) {
  const { data } = await api.post(`/admin/scrape/${sourceId}`);
  return data;
}

export async function triggerScrapeAll() {
  const { data } = await api.post('/admin/scrape-all');
  return data;
}

export async function triggerShadowTest() {
  const { data } = await api.post('/admin/shadow-test');
  return data;
}

export async function verifyIntegrity() {
  const { data } = await api.post('/admin/verify-integrity');
  return data;
}

export async function computeStateHash() {
  const { data } = await api.post('/admin/state-hash');
  return data;
}

export async function getPipelineRuns(limit = 50) {
  const { data } = await api.get('/admin/pipeline-runs', { params: { limit } });
  return data;
}

export async function triggerAudit(deepAudit = false) {
  const { data } = await api.post('/admin/audit', null, { params: deepAudit ? { deepAudit: 'true' } : {} });
  return data;
}

// ─── Staged Content ─────────────────────────────────────────────

export interface StagedItem {
  id: string;
  sourceId: string;
  contentHash: string;
  fetchedAt: string;
  wordCount: number;
  source: 'scrape' | 'upload';
  // Verification (Step 3)
  verificationPassed: boolean | null;
  verificationIssues: string | null; // JSON array of VerificationIssue
  verificationStats: string | null; // JSON of verification stats
  llmSpotCheckUsed: boolean;
  // Quality scoring
  qualityGrade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  qualityStructure: number | null;
  qualityText: number | null;
  qualityIssues: string | null; // JSON array
  qualityDiagnostic: string | null;
  // Pipeline state
  pipelineStep: number;
  pipelineStatus: string;
  pipelineError: string | null;
  retryCount: number;
  extractedCount: number;
  scoredCount: number;
  rejectedCount: number;
  llmProvider: string | null;
  llmModel: string | null;
  llmTokensIn: number;
  llmTokensOut: number;
  llmCostCents: number;
  healingAttempted: boolean;
  healingStrategy: string | null;
  healingLog: string | null; // JSON array of {strategy, result, grade, durationMs}
  createdAt: string;
  updatedAt: string;
  sourceName: string | null;
  sourceJurisdiction: string | null;
}

export async function getStagedContent(status?: string) {
  const params: Record<string, string> = {};
  if (status) params.status = status;
  const { data } = await api.get('/admin/staged', { params });
  return data as { count: number; staged: StagedItem[] };
}

export async function approveStagedContent(id: string) {
  const { data } = await api.post(`/admin/staged/${id}/approve`);
  return data;
}

export async function rejectStagedContent(id: string, reason?: string) {
  const { data } = await api.post(`/admin/staged/${id}/reject`, { reason: reason || 'Manually rejected by admin' });
  return data;
}

export async function retryStagedContent(id: string) {
  const { data } = await api.post(`/admin/staged/${id}/retry`);
  return data;
}

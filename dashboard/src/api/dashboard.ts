import api from './client';

export interface DashboardStats {
  rules: number;
  sources: number;
  tenants: number;
  connectedClients: number;
  lastPipelineRun: { status: string; completedAt: string } | null;
  latestStateHash: { hash: string; ruleCount: number; computedAt: string } | null;
}

export async function getStats(): Promise<DashboardStats> {
  const { data } = await api.get('/dashboard/stats');
  return data;
}

export async function getPipelineHistory(limit = 50) {
  const { data } = await api.get('/dashboard/pipeline-history', { params: { limit } });
  return data;
}

export async function getCostBreakdown(since?: string) {
  const { data } = await api.get('/dashboard/cost-breakdown', { params: { since } });
  return data;
}

import api from './client';

export interface RegulatorySignal {
  id: string;
  sourceId: string | null;
  title: string;
  jurisdiction: string;
  stage: 'signal' | 'draft' | 'committee' | 'adopted' | 'active';
  likelihoodPercent: number;
  summary: string;
  sourceUrl: string | null;
  detectedAt: string;
  expectedEffectiveDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getSignals(params?: {
  jurisdiction?: string;
  stage?: string;
}): Promise<{ count: number; signals: RegulatorySignal[] }> {
  const { data } = await api.get('/radar', { params });
  return data;
}

export async function createSignal(signal: {
  title: string;
  jurisdiction: string;
  stage?: string;
  likelihoodPercent?: number;
  summary: string;
  sourceUrl?: string;
  expectedEffectiveDate?: string;
}): Promise<RegulatorySignal> {
  const { data } = await api.post('/radar', signal);
  return data;
}

export async function updateSignal(id: string, updates: Partial<RegulatorySignal>): Promise<void> {
  await api.patch(`/radar/${id}`, updates);
}

export async function deleteSignal(id: string): Promise<void> {
  await api.delete(`/radar/${id}`);
}

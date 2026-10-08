import api from './client';

export interface ScoutFeed {
  id: string;
  name: string;
  url: string;
  feedType: 'rss' | 'atom' | 'google_news' | 'webpage' | 'gov_api';
  category: string;
  jurisdiction: string;
  isActive: boolean;
  checkIntervalHours: number;
  lastCheckedAt: string | null;
  lastItemCount: number;
  errorCount: number;
  lastError: string | null;
  apiConfig: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScoutItem {
  id: string;
  feedId: string;
  title: string;
  url: string;
  publishedAt: string | null;
  rawSnippet: string | null;
  status: 'pending' | 'accepted' | 'rejected' | 'auto_promoted';
  keywordScore: number | null;
  llmRelevant: boolean | null;
  confidenceScore: number | null;
  extractedSignal: {
    title: string;
    jurisdiction: string;
    stage: string;
    likelihoodPercent: number;
    summary: string;
  } | null;
  promotedSignalId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  llmCostCents: number;
  discoveredAt: string;
}

export interface ScoutStats {
  activeFeeds: number;
  itemsByStatus: Record<string, number>;
  monthlyLlmCostCents: number;
}

export interface ScoutCycleResult {
  feedsProcessed: number;
  itemsFetched: number;
  itemsNew: number;
  itemsKeywordRejected: number;
  itemsLlmClassified: number;
  itemsExtracted: number;
  itemsAutoPromoted: number;
  totalLlmCostCents: number;
  durationMs: number;
}

export interface ScoutApiKeyInfo {
  congressGov: string;
  configured: { congressGov: boolean };
  providers: Array<{
    id: string;
    name: string;
    required: boolean;
    signupUrl?: string;
    description: string;
  }>;
}

// ─── Feeds ───────────────────────────────────────────────────

export async function getFeeds(): Promise<{ count: number; feeds: ScoutFeed[] }> {
  const { data } = await api.get('/scout/feeds');
  return data;
}

export async function createFeed(feed: {
  name: string;
  url: string;
  feedType: string;
  category?: string;
  jurisdiction?: string;
  checkIntervalHours?: number;
  apiConfig?: object;
}): Promise<ScoutFeed> {
  const { data } = await api.post('/scout/feeds', feed);
  return data;
}

export async function updateFeed(id: string, updates: Partial<ScoutFeed>): Promise<void> {
  await api.patch(`/scout/feeds/${id}`, updates);
}

export async function deleteFeed(id: string): Promise<void> {
  await api.delete(`/scout/feeds/${id}`);
}

export async function seedFeeds(): Promise<{ message: string }> {
  const { data } = await api.post('/scout/feeds/seed');
  return data;
}

// ─── Items ───────────────────────────────────────────────────

export async function getItems(params?: {
  status?: string;
  feedId?: string;
  limit?: number;
  offset?: number;
}): Promise<{ count: number; items: ScoutItem[] }> {
  const { data } = await api.get('/scout/items', { params });
  return data;
}

export async function acceptItem(id: string, overrides?: {
  title?: string;
  jurisdiction?: string;
  stage?: string;
  likelihoodPercent?: number;
  summary?: string;
}): Promise<{ message: string; signalId: string }> {
  const { data } = await api.post(`/scout/items/${id}/accept`, overrides ?? {});
  return data;
}

export async function rejectItem(id: string): Promise<void> {
  await api.post(`/scout/items/${id}/reject`);
}

export async function bulkReview(action: 'accept' | 'reject', itemIds: string[]): Promise<void> {
  await api.post('/scout/items/bulk-review', { action, itemIds });
}

// ─── Stats + Trigger ─────────────────────────────────────────

export async function getStats(): Promise<ScoutStats> {
  const { data } = await api.get('/scout/stats');
  return data;
}

export async function triggerCycle(): Promise<{ message: string; result: ScoutCycleResult }> {
  const { data } = await api.post('/scout/trigger');
  return data;
}

// ─── API Keys ────────────────────────────────────────────────

export async function getScoutApiKeys(): Promise<ScoutApiKeyInfo> {
  const { data } = await api.get('/settings/scout-api-keys');
  return data;
}

export async function updateScoutApiKeys(keys: { congressGov?: string }): Promise<void> {
  await api.put('/settings/scout-api-keys', keys);
}

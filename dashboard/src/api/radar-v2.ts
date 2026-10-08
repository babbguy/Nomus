import api from './client';

// ─── Types ──────────────────────────────────────────────────────

export interface TrackedBill {
  id: string;
  externalId: string | null;
  title: string;
  summary: string | null;
  jurisdiction: string;
  session: string | null;
  introducedDate: string | null;
  currentStage: string;
  progressPercent: number;
  passageScore: number | null;
  passageMomentum: number | null;
  passageBaseRate: number | null;
  passageSponsorStrength: number | null;
  passageSentiment: number | null;
  passagePolitical: number | null;
  passageOpposition: number | null;
  sourceUrl: string | null;
  sourceFeed: string | null;
  lastActionDate: string | null;
  lastScoreDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillStageHistoryEntry {
  id: number;
  billId: string;
  stage: string;
  enteredAt: string;
  exitedAt: string | null;
  source: string | null;
}

export interface BillScoreHistoryEntry {
  id: number;
  billId: string;
  score: number;
  momentum: number | null;
  baseRate: number | null;
  sponsorStrength: number | null;
  sentiment: number | null;
  political: number | null;
  opposition: number | null;
  computedAt: string;
}

export interface BillNewsArticle {
  id: number;
  billId: string;
  title: string;
  url: string;
  sourceName: string | null;
  publishedAt: string | null;
  sentiment: 'supportive' | 'opposed' | 'neutral' | 'mixed' | null;
  sentimentScore: number | null;
  fetchedAt: string;
}

export interface BillListResponse {
  bills: TrackedBill[];
  total: number;
  page: number;
  limit: number;
}

export interface RadarStats {
  totalBills: number;
  byJurisdiction: Record<string, number>;
  byStage: Record<string, number>;
  avgScore: number;
}

export interface BillMover {
  id: string;
  title: string;
  jurisdiction: string;
  currentStage: string;
  currentScore: number;
  previousScore: number;
  change: number;
}

// ─── API Functions ──────────────────────────────────────────────

export async function getBills(params?: {
  jurisdiction?: string;
  stage?: string;
  minScore?: number;
  maxScore?: number;
  page?: number;
  limit?: number;
}): Promise<BillListResponse> {
  const { data } = await api.get('/radar/v2/bills', { params });
  return data;
}

export async function getBill(id: string): Promise<{ bill: TrackedBill }> {
  const { data } = await api.get(`/radar/v2/bills/${id}`);
  return data;
}

export async function getBillTimeline(id: string): Promise<{ stages: BillStageHistoryEntry[] }> {
  const { data } = await api.get(`/radar/v2/bills/${id}/timeline`);
  return data;
}

export async function getBillScores(id: string, days?: number): Promise<{ scores: BillScoreHistoryEntry[] }> {
  const { data } = await api.get(`/radar/v2/bills/${id}/scores`, { params: days ? { days } : undefined });
  return data;
}

export async function getBillNews(id: string): Promise<{ articles: BillNewsArticle[] }> {
  const { data } = await api.get(`/radar/v2/bills/${id}/news`);
  return data;
}

export async function getRadarStats(): Promise<RadarStats> {
  const { data } = await api.get('/radar/v2/stats');
  return data;
}

export async function getTopMovers(params?: {
  days?: number;
  limit?: number;
}): Promise<{ movers: BillMover[]; days: number }> {
  const { data } = await api.get('/radar/v2/movers', { params });
  return data;
}


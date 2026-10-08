import api from './client';

export interface AuditIssue {
  type: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  ruleId?: string;
}

export interface AuditResult {
  sourceId: string;
  snapshotGrade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  ruleCount: number;
  issueCount: number;
  issues: AuditIssue[];
  llmReauditScore: number | null;
  llmReauditSample: number;
  overallVerdict: 'pass' | 'warn' | 'fail';
  durationMs: number;
  auditedAt: string;
}

/** Who owns a source: 'registry' = built-in, 'customized' = edited built-in, 'custom' = added by an admin. */
export type SourceOrigin = 'registry' | 'customized' | 'custom';

export interface RegulatorySource {
  id: string;
  name: string;
  jurisdiction: string;
  url: string;
  parserType: string;
  origin: SourceOrigin | null;
  registryKey: string | null;
  category: string | null;
  tier: number;
  needsHeadless: boolean;
  selectorConfig: Record<string, unknown>;
  scrapeFrequencyHours: number;
  ingestionMode: 'auto' | 'manual';
  isActive: boolean;
  lastScrapedAt: string | null;
  lastContentHash: string | null;
  consecutiveFailures: number;
  auditResult: AuditResult | null;
  contentVerification: 'verified' | 'cleaned' | 'failed' | null;
  contentVerificationAt: string | null;
  contentVerificationIssues: Array<{ type: string; description: string; location: string }> | null;
  createdAt: string;
  updatedAt: string;
}

export async function getSources(): Promise<{ count: number; sources: RegulatorySource[] }> {
  const { data } = await api.get('/sources');
  return data;
}

/** Result of a change that may retire or restore the source's rules. */
export type SourceChange = RegulatorySource & { rulesRetired?: number; rulesRestored?: number };

export async function createSource(source: Partial<RegulatorySource>): Promise<RegulatorySource> {
  const { data } = await api.post('/sources', source);
  return data;
}

export async function updateSource(id: string, updates: Partial<RegulatorySource>): Promise<SourceChange> {
  const { data } = await api.patch(`/sources/${id}`, updates);
  return data;
}

/** Deactivate a source. Its rules stop applying. */
export async function deleteSource(id: string): Promise<{ message: string; rulesRetired: number }> {
  const { data } = await api.delete(`/sources/${id}`);
  return data;
}

/** Put a customized built-in source back to the built-in registry values. */
export async function restoreSourceDefaults(id: string): Promise<RegulatorySource> {
  const { data } = await api.post(`/sources/${id}/restore-defaults`);
  return data;
}

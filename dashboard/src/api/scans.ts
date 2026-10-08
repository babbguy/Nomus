import api from './client';

export interface ScanFinding {
  id: string;
  repo: string;
  prNumber: number | null;
  commitSha: string;
  filePath: string;
  lineNumber: number;
  ruleKey: string;
  severity: string;
  effect: string;
  capabilityDetected: string;
  humanSummary: string;
  suggestion: string | null;
  detectorSource: string | null;
  legalReference: string | null;
  status: string;
  scannedAt: string;
}

export interface ScanRepo {
  repo: string;
  totalFindings: number;
  openFindings: number;
  lastScanned: string;
}

export async function getScanFindings(params?: Record<string, string>) {
  const { data } = await api.get('/scan/findings', { params });
  return data as { count: number; findings: ScanFinding[] };
}

export async function getScanRepos() {
  const { data } = await api.get('/scan/repos');
  return data as { count: number; repos: ScanRepo[] };
}

export async function dismissFinding(id: string, status: 'dismissed' | 'resolved') {
  const { data } = await api.patch(`/scan/findings/${id}`, { status });
  return data;
}

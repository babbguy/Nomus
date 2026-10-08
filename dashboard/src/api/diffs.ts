import api from './client';

export interface DiffSection {
  type: 'added' | 'removed' | 'context';
  content: string;
  lineNumber: number;
}

export interface SnapshotInfo {
  date: string;
  hash: string;
}

export interface DiffResponse {
  sourceId: string;
  sourceName: string;
  jurisdiction: string;
  previousSnapshot: SnapshotInfo;
  currentSnapshot: SnapshotInfo;
  sections: DiffSection[];
  linesAdded: number;
  linesRemoved: number;
  sectionsChanged: number;
}

export interface SnapshotListItem {
  id: string;
  contentHash: string;
  scrapedAt: string;
}

export interface SnapshotListResponse {
  sourceId: string;
  sourceName: string;
  count: number;
  snapshots: SnapshotListItem[];
}

export async function getSourceDiff(sourceId: string, snapshotId?: string): Promise<DiffResponse> {
  const params = snapshotId ? { snapshotId } : {};
  const { data } = await api.get(`/admin/diffs/${sourceId}`, { params });
  return data;
}

export async function getSourceSnapshots(sourceId: string): Promise<SnapshotListResponse> {
  const { data } = await api.get(`/admin/diffs/${sourceId}/snapshots`);
  return data;
}

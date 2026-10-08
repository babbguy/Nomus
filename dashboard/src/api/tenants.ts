import api from './client';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  jurisdictionAccess: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function createTenant(data: { name: string; slug: string }): Promise<Tenant> {
  const { data: result } = await api.post('/tenants', data);
  return result;
}

export async function getTenant(id: string): Promise<Tenant> {
  const { data } = await api.get(`/tenants/${id}`);
  return data;
}

export async function generateApiKey(orgId: string, data: { label: string; scopes: string[] }) {
  const { data: result } = await api.post(`/tenants/${orgId}/api-keys`, data);
  return result;
}

export async function revokeApiKey(orgId: string, keyId: string) {
  await api.delete(`/tenants/${orgId}/api-keys/${keyId}`);
}

export async function getApiKeys(orgId: string) {
  const { data } = await api.get(`/tenants/${orgId}/api-keys`);
  return data as { count: number; keys: ApiKeyInfo[] };
}

export async function updateTenant(orgId: string, updates: Record<string, unknown>) {
  await api.patch(`/tenants/${orgId}`, updates);
}

export interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  label: string;
  scopes: string[];
  isActive: boolean;
  /** Effective state: an unrevoked key past expiresAt is expired. */
  status?: 'active' | 'revoked' | 'expired';
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

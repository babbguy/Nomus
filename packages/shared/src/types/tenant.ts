export type ApiKeyScope =
  | 'read:policies'
  | 'stream'
  | 'evaluate'
  | 'admin';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  jurisdictionAccess: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKey {
  id: string;
  orgId: string;
  keyPrefix: string;
  label: string;
  scopes: ApiKeyScope[];
  rateLimitRpm: number;
  lastUsedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

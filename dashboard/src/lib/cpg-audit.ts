import type { AuditQuery } from '../api/cpg';

/** The audit actions the engine writes in Phase 1 (engine/src/cpg, appendAuditEvent). */
export const AUDIT_ACTIONS = [
  'rbac.roles_seeded', 'rbac.migrated', 'settings.initialized', 'settings.updated',
  'role.created', 'role.updated', 'role.permissions_changed', 'role.archived',
  'user.invited', 'user.updated', 'grant.created', 'grant.revoked',
  'team.created', 'team.updated',
] as const;

const PAGE_SIZE = 50;

export interface AuditFilters { action: string; since: string; until: string }

/** UTC day bounds for the date filters (the API takes ISO-8601 UTC). */
export function auditFilterQuery(f: AuditFilters): AuditQuery | { error: string } {
  const q: AuditQuery = { limit: PAGE_SIZE };
  if (f.action) q.action = f.action;
  if (f.since) q.since = `${f.since}T00:00:00.000Z`;
  if (f.until) q.until = `${f.until}T23:59:59.999Z`;
  if (f.since && f.until && f.since > f.until) return { error: 'The "from" date is after the "to" date.' };
  return q;
}


import type { AuditEvent, CpgMe, CpgSettings, OrgUser, Permission, Role, Team } from '../api/cpg-schemas';

/**
 * Response bodies shaped exactly like the engine's (docs/api-reference/governance.md),
 * for the dashboard's contract and component tests. Neutral example values only.
 */

export const ORG_ID = '6f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f';
export const OWNER_ID = '0b6c1d2e-3f40-4152-8a63-7b8c9d0e1f20';
export const DEV_ID = '1c7d2e3f-4051-4263-9b74-8c9d0e1f2031';
export const ROLE_ADMIN_ID = '2d8e3f40-5162-4374-ac85-9d0e1f203142';
export const ROLE_DEV_ID = '3e9f4051-6273-4485-bd96-0e1f20314253';
export const ROLE_CUSTOM_ID = '4fa05162-7384-4596-8ea7-1f2031425364';
export const TEAM_ID = '50b16273-8495-46a7-9fb8-203142536475';
const T = '2026-10-08T12:00:00.000Z';
const HASH = (c: string) => c.repeat(64);

export const permissions: Permission[] = [
  { key: 'org.members.read', category: 'org', scopable: false, description: 'Read the organization members' },
  { key: 'org.settings.manage', category: 'org', scopable: false, description: 'Change governance settings' },
  { key: 'rbac.users.manage', category: 'rbac', scopable: false, description: 'Invite users, grant and revoke roles' },
  { key: 'rbac.roles.manage', category: 'rbac', scopable: false, description: 'Manage roles' },
  { key: 'policy.read', category: 'policy', scopable: false, description: 'Read the policy log' },
  { key: 'case.read', category: 'case', scopable: true, description: 'Read review cases' },
  { key: 'case.comment', category: 'case', scopable: true, description: 'Comment on review cases' },
  { key: 'audit.read', category: 'audit', scopable: false, description: 'Read the audit log' },
];

export const roles: Role[] = [
  {
    id: ROLE_ADMIN_ID, key: 'org_admin', name: 'Org Admin', description: 'Manages users, roles and settings.', isSystem: true,
    permissions: ['audit.read', 'org.members.read', 'org.settings.manage', 'policy.read', 'rbac.roles.manage', 'rbac.users.manage'],
    createdAt: T, createdBy: 'system:seed', archivedAt: null, archivedBy: null,
  },
  {
    id: ROLE_DEV_ID, key: 'developer', name: 'Developer', description: 'Requests reviews.', isSystem: true,
    permissions: ['case.comment', 'case.read', 'org.members.read', 'policy.read'],
    createdAt: T, createdBy: 'system:seed', archivedAt: null, archivedBy: null,
  },
  {
    id: ROLE_CUSTOM_ID, key: 'repo_reader', name: 'Repo Reader', description: '', isSystem: false,
    permissions: ['case.read'], createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null, archivedBy: null,
  },
];

export const teams: Team[] = [
  { id: TEAM_ID, key: 'payments', name: 'Payments', repoPatterns: ['example-org/payments-*'], createdAt: T, createdBy: `user:${OWNER_ID}`, archivedAt: null },
];

const grant = (id: string, userId: string, role: Role, scopeType: 'org' | 'team' | 'repo' = 'org', scopeId: string | null = null) => ({
  id, userId, roleId: role.id, roleKey: role.key, roleName: role.name, scopeType, scopeId,
  grantedBy: 'system:rbac-migration', grantedAt: T, revokedAt: null, revokedBy: null, revokeReason: null,
});

export const users: OrgUser[] = [
  {
    id: OWNER_ID, name: 'Owner One', email: 'owner@example.org', isActive: true, mustChangePassword: false,
    grants: [grant('60c27384-95a6-47b8-a0c9-314253647586', OWNER_ID, roles[0]), grant('71d38495-a6b7-48c9-b1da-425364758697', OWNER_ID, roles[1])],
    boards: [],
  },
  {
    id: DEV_ID, name: 'Dev Two', email: 'dev@example.org', isActive: false, mustChangePassword: true,
    grants: [
      grant('82e495a6-b7c8-49da-82eb-5364758697a8', DEV_ID, roles[1]),
      grant('93f5a6b7-c8d9-4aeb-93fc-64758697a8b9', DEV_ID, roles[2], 'team', TEAM_ID),
      grant('a406b7c8-d9ea-4bfc-a40d-758697a8b9ca', DEV_ID, roles[2], 'repo', 'example-org/api'),
    ],
    boards: [],
  },
];

export const settings: CpgSettings = {
  orgId: ORG_ID, enabled: false, reviewerContextLlm: true, llmProviderConfigured: true,
  rbacMigratedAt: T, updatedAt: T, updatedBy: 'system:seed',
};

export const auditEvents: AuditEvent[] = [
  {
    id: 'b517c8d9-eafb-4c0d-b51e-8697a8b9cadb', seq: 2, actor: `user:${OWNER_ID}`, action: 'grant.created', targetType: 'grant',
    targetId: '93f5a6b7-c8d9-4aeb-93fc-64758697a8b9', payload: { userId: DEV_ID, roleKey: 'repo_reader', scopeType: 'team', scopeId: TEAM_ID },
    prevHash: HASH('a'), hash: HASH('b'), createdAt: T,
  },
  {
    id: 'c628d9ea-fb0c-4d1e-862f-97a8b9cadbec', seq: 1, actor: 'system:rbac-migration', action: 'rbac.migrated', targetType: 'org',
    targetId: ORG_ID, payload: { ownerUserId: OWNER_ID, developerCount: 1 }, prevHash: HASH('0'), hash: HASH('a'), createdAt: T,
  },
];

export function me(overrides: Partial<CpgMe> = {}): CpgMe {
  return {
    user: { id: OWNER_ID, name: 'Owner One', email: 'owner@example.org' },
    orgId: ORG_ID,
    cpgEnabled: false,
    isPlatformAdmin: false,
    permissions: roles[0].permissions.map((key) => ({ key, scope: 'org' as const, scopeId: null })),
    boards: [],
    identity: 'session',
    ...overrides,
  };
}

/** Text a page must never show (the release gate's broken-value rules). */
export const BROKEN = [/\bNaN\b/, /\bundefined\b/, /\[object Object\]/, /Invalid Date/];

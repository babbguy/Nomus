/**
 * The CPG permission catalog and the seven system roles (design spec §3.1,
 * §3.2). The catalog is seeded into `cpg_permissions` on every start with
 * INSERT OR IGNORE; system roles are created per org by seed.ts.
 */

export type PermissionCategory = 'org' | 'rbac' | 'policy' | 'case' | 'exception' | 'audit' | 'integration' | 'ci';

export interface PermissionDef {
  key: string;
  category: PermissionCategory;
  /** Honoured from team- and repo-scoped grants. Non-scopable permissions need an org-scoped grant. */
  scopable: boolean;
  description: string;
}

export const PERMISSIONS = [
  { key: 'org.profile.update', category: 'org', scopable: false, description: 'Update the organization profile (PATCH /api/v1/org)' },
  { key: 'org.api_keys.manage', category: 'org', scopable: false, description: 'List, create and revoke organization API keys' },
  { key: 'org.members.read', category: 'org', scopable: false, description: 'Read the organization members, roles and teams' },
  { key: 'org.settings.manage', category: 'org', scopable: false, description: 'Enable corporate policy governance and change its settings' },
  { key: 'rbac.users.manage', category: 'rbac', scopable: false, description: 'Invite or deactivate organization users; grant or revoke roles' },
  { key: 'rbac.roles.manage', category: 'rbac', scopable: false, description: 'Create, edit and archive custom roles; edit system-role permissions' },
  { key: 'rbac.teams.manage', category: 'rbac', scopable: false, description: 'Manage teams and their repositories' },
  { key: 'boards.manage', category: 'org', scopable: false, description: 'Manage review boards and their membership' },
  { key: 'quorum.manage', category: 'org', scopable: false, description: 'Create new approval quorum configuration versions' },
  { key: 'integrations.manage', category: 'integration', scopable: false, description: 'Manage integrations, rotate secrets, test and retry deliveries' },
  { key: 'policy.read', category: 'policy', scopable: false, description: 'Read the corporate policy log and governance settings' },
  { key: 'policy.author', category: 'policy', scopable: false, description: 'Compile and propose corporate policies, versions and retirements' },
  { key: 'policy.approve', category: 'policy', scopable: false, description: 'Vote on proposed policy versions (never on your own proposal)' },
  { key: 'case.create', category: 'case', scopable: true, description: 'Request a review, add justifications, submit revisions, withdraw own case' },
  { key: 'case.read', category: 'case', scopable: true, description: 'Read review cases, revisions, snippets and reviewer context' },
  { key: 'case.comment', category: 'case', scopable: true, description: 'Comment on review cases' },
  { key: 'case.review', category: 'case', scopable: true, description: 'Propose snippet or bulk decisions, vote and request changes' },
  { key: 'case.close', category: 'case', scopable: true, description: 'Close a review case' },
  { key: 'exception.propose', category: 'exception', scopable: true, description: 'Propose standing exceptions' },
  { key: 'exception.approve', category: 'exception', scopable: true, description: 'Vote on standing-exception proposals' },
  { key: 'decision.revoke', category: 'exception', scopable: true, description: 'Revoke a decision or standing exception' },
  { key: 'audit.read', category: 'audit', scopable: false, description: 'Read the governance audit log, CI runs and delivery log' },
  { key: 'audit.export', category: 'audit', scopable: false, description: 'Export signed governance audit records' },
  { key: 'ci.read', category: 'ci', scopable: true, description: 'List CI runs for a repository' },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const SCOPABLE = new Map<string, boolean>(PERMISSIONS.map((p) => [p.key, p.scopable]));

export function isPermissionKey(key: string): key is PermissionKey {
  return SCOPABLE.has(key);
}

/** True when the permission may be exercised through a team- or repo-scoped grant. */
export function isScopable(key: string): boolean {
  return SCOPABLE.get(key) === true;
}

export type SystemRoleKey =
  | 'org_admin'
  | 'policy_author'
  | 'policy_approver'
  | 'case_reviewer'
  | 'exception_approver'
  | 'developer'
  | 'auditor';

export interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

/** §3.2. Org Admin deliberately holds no approval permission. */
export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'org_admin',
    name: 'Org Admin',
    description: 'Manages users, roles, teams, boards, quorum, integrations and settings. Approves nothing by itself.',
    permissions: [
      'org.profile.update', 'org.api_keys.manage', 'org.members.read', 'org.settings.manage',
      'rbac.users.manage', 'rbac.roles.manage', 'rbac.teams.manage', 'boards.manage', 'quorum.manage',
      'integrations.manage', 'policy.read', 'case.read', 'case.close', 'audit.read', 'ci.read',
    ],
  },
  {
    key: 'policy_author',
    name: 'Policy Author',
    description: 'Writes and proposes corporate policies.',
    permissions: ['org.members.read', 'policy.read', 'policy.author', 'case.read', 'case.comment', 'ci.read'],
  },
  {
    key: 'policy_approver',
    name: 'Policy Approver',
    description: 'Approves or rejects proposed policy versions written by someone else.',
    permissions: ['org.members.read', 'policy.read', 'policy.approve', 'case.read', 'case.comment', 'ci.read'],
  },
  {
    key: 'case_reviewer',
    name: 'Case Reviewer',
    description: 'Reviews cases for the boards they belong to; may add policies from inside a case.',
    permissions: [
      'org.members.read', 'policy.read', 'policy.author', 'case.read', 'case.comment', 'case.review',
      'case.close', 'exception.propose', 'ci.read',
    ],
  },
  {
    key: 'exception_approver',
    name: 'Exception Approver',
    description: 'Proposes, approves and revokes standing exceptions.',
    permissions: [
      'org.members.read', 'policy.read', 'case.read', 'case.comment', 'exception.propose',
      'exception.approve', 'decision.revoke', 'ci.read',
    ],
  },
  {
    key: 'developer',
    name: 'Developer',
    description: 'Requests reviews and justifies findings. Keeps the v1.1.0 member abilities (organization profile and API keys).',
    permissions: [
      'org.profile.update', 'org.api_keys.manage', 'org.members.read', 'policy.read',
      'case.create', 'case.read', 'case.comment', 'ci.read',
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to governance records, plus export.',
    permissions: ['org.members.read', 'policy.read', 'case.read', 'audit.read', 'audit.export', 'ci.read'],
  },
];

export const SYSTEM_ROLE_KEYS: readonly SystemRoleKey[] = SYSTEM_ROLES.map((r) => r.key);

/** Permissions the system org_admin role may never lose (anti-lockout, §3.4). */
export const ORG_ADMIN_LOCKED_PERMISSIONS: readonly PermissionKey[] = ['rbac.roles.manage', 'rbac.users.manage'];

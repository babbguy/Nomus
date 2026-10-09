import type { CpgMe, Grant, Team } from '../api/cpg-schemas';

/**
 * Pure helpers for the governance pages: permission checks against
 * GET /cpg/me, the page catalog the sidebar and route guards share, and
 * display of audit actors and grant scopes. No React, no network.
 */

/** What a page needs: every permission in `all`, and at least one in `any`. */
export interface PermissionRequirement {
  all?: string[];
  any?: string[];
  /** Scopable permissions, held through a grant of any scope (organization, team or repository). */
  scoped?: string[];
}

/**
 * Whether the user holds a permission org-wide. The Phase 1 governance
 * permissions are not scopable (design spec §3.1), and a check without a
 * repository considers only org-scoped grants (§3.3), exactly as the engine
 * does, so the UI never offers what the API would refuse.
 */
export function hasOrgPermission(me: CpgMe | null | undefined, key: string): boolean {
  return !!me && me.permissions.some((p) => p.key === key && p.scope === 'org');
}

/** Whether the user holds a scopable permission in any scope (the server then checks each repository). */
export function holdsPermission(me: CpgMe | null | undefined, key: string): boolean {
  return !!me && me.permissions.some((p) => p.key === key);
}

/** The permissions a requirement still lacks; empty when it is met. */
export function missingPermissions(me: CpgMe | null | undefined, req: PermissionRequirement): string[] {
  const missing = [...(req.all ?? []).filter((k) => !hasOrgPermission(me, k)), ...(req.scoped ?? []).filter((k) => !holdsPermission(me, k))];
  if (req.any && req.any.length > 0 && !req.any.some((k) => hasOrgPermission(me, k))) {
    missing.push(req.any.join(' or '));
  }
  return missing;
}

export function meetsRequirement(me: CpgMe | null | undefined, req: PermissionRequirement): boolean {
  return missingPermissions(me, req).length === 0;
}

export type GuardDecision = 'loading' | 'error' | 'allow' | 'deny';

/** What a permission-guarded route does for the current /cpg/me state. */
export function guardDecision(
  state: { status: 'idle' | 'loading' | 'ready' | 'error'; me: CpgMe | null },
  req: PermissionRequirement,
): GuardDecision {
  if (state.status === 'error') return 'error';
  if (state.status !== 'ready' || !state.me) return 'loading';
  return meetsRequirement(state.me, req) ? 'allow' : 'deny';
}

export interface GovernancePage {
  to: string;
  label: string;
  description: string;
  requires: PermissionRequirement;
}

export const ACCESS_REQUIREMENT: PermissionRequirement = {
  all: ['org.members.read'],
  any: ['rbac.users.manage', 'rbac.roles.manage', 'rbac.teams.manage'],
};
export const AUDIT_REQUIREMENT: PermissionRequirement = { all: ['audit.read'] };
export const SETTINGS_REQUIREMENT: PermissionRequirement = { all: ['policy.read'] };
export const POLICIES_REQUIREMENT: PermissionRequirement = { all: ['policy.read'] };
export const POLICY_AUTHOR_REQUIREMENT: PermissionRequirement = { all: ['policy.read', 'policy.author'] };
export const BOARDS_REQUIREMENT: PermissionRequirement = { all: ['policy.read'] };
export const QUORUM_REQUIREMENT: PermissionRequirement = { all: ['policy.read'] };
export const CASES_REQUIREMENT: PermissionRequirement = { scoped: ['case.read'] };

/** The governance pages, in sidebar order. */
export const GOVERNANCE_PAGES: GovernancePage[] = [
  { to: '/governance', label: 'Overview', description: 'Your governance access and status', requires: {} },
  { to: '/governance/policies', label: 'Policies', description: 'The corporate policy log: versions, approvals, grace periods', requires: POLICIES_REQUIREMENT },
  { to: '/governance/cases', label: 'Cases', description: 'One case per branch: findings, justifications and board review', requires: CASES_REQUIREMENT },
  { to: '/governance/exceptions', label: 'Exceptions', description: 'Standing exceptions: approvals that cover future findings matching a pattern', requires: CASES_REQUIREMENT },
  { to: '/governance/boards', label: 'Boards', description: 'Review boards, their members and the policies they own', requires: BOARDS_REQUIREMENT },
  { to: '/governance/quorum', label: 'Quorum', description: 'Who must approve what, versioned and signed', requires: QUORUM_REQUIREMENT },
  { to: '/governance/access', label: 'Access', description: 'Users, role grants, custom roles and teams', requires: ACCESS_REQUIREMENT },
  { to: '/governance/audit', label: 'Audit log', description: 'Every access and settings change, hash-chained', requires: AUDIT_REQUIREMENT },
  { to: '/governance/settings', label: 'Settings', description: 'Turn governance on, reviewer context', requires: SETTINGS_REQUIREMENT },
];

/** Pages reached from another page rather than the sidebar (named in redirect explanations). */
const SUB_PAGES: GovernancePage[] = [
  { to: '/governance/policies/new', label: 'New policy', description: 'Write and compile a corporate policy', requires: POLICY_AUTHOR_REQUIREMENT },
];

export function pageByPath(pathname: string): GovernancePage | undefined {
  return GOVERNANCE_PAGES.find((p) => p.to === pathname) ?? SUB_PAGES.find((p) => p.to === pathname);
}

/**
 * The sidebar shows the Governance group when the user holds any governance
 * permission and governance is on, or they can turn it on (spec §14.1).
 */
export function showGovernanceNav(me: CpgMe | null | undefined): boolean {
  if (!me || me.permissions.length === 0) return false;
  return me.cpgEnabled || hasOrgPermission(me, 'org.settings.manage');
}

export function visibleGovernancePages(me: CpgMe | null | undefined): GovernancePage[] {
  return GOVERNANCE_PAGES.filter((p) => meetsRequirement(me, p.requires));
}

const SYSTEM_ACTORS: Record<string, string> = {
  'system:seed': 'System (initial setup)',
  'system:rbac-migration': 'System (upgrade migration)',
  'system:quorum': 'System (quorum reached)',
  'system:lapse': 'System (proposal lapsed)',
};

/**
 * A readable name for an audit actor (`user:<uuid>`, `system:<what>`).
 * Unknown users keep their full id: ids are never shortened.
 */
export function formatActor(actor: string, usersById?: ReadonlyMap<string, { name: string; email: string }>): string {
  if (SYSTEM_ACTORS[actor]) return SYSTEM_ACTORS[actor];
  if (actor.startsWith('user:')) {
    const id = actor.slice('user:'.length);
    const u = usersById?.get(id);
    return u ? (u.email || u.name || id) : `User ${id}`;
  }
  if (actor.startsWith('system:')) return `System (${actor.slice('system:'.length)})`;
  return actor || 'Unknown';
}

/** "Organization", "Team Payments" or "Repository example-org/api". */
export function describeScope(grant: Pick<Grant, 'scopeType' | 'scopeId'>, teamsById?: ReadonlyMap<string, Pick<Team, 'name' | 'key'>>): string {
  if (grant.scopeType === 'org') return 'Organization';
  if (grant.scopeType === 'team') {
    const team = grant.scopeId ? teamsById?.get(grant.scopeId) : undefined;
    return `Team ${team ? team.name : (grant.scopeId ?? 'unknown')}`;
  }
  return `Repository ${grant.scopeId ?? 'unknown'}`;
}

/**
 * Canonical repository id, as the engine requires for repo-scoped grants
 * (mirrors CANONICAL_REPO_RE in engine/src/cpg/rbac/grants.ts). A hint for
 * the form only; the server re-validates (422 invalid_repo).
 */
export function isCanonicalRepo(value: string): boolean {
  return value.length <= 200 && /^[a-z0-9.-]+(\/[a-z0-9._-]+){1,2}$/.test(value)
    && !value.split('/').some((seg) => seg === '.' || seg === '..');
}

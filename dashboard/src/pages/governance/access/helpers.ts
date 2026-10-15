import type { OrgUser, Permission, PermissionCategory, Role, Team } from '../../../api/cpg';

/** Everything the Access page loads (E7, E3, E12, E2). */
export interface AccessData {
  users: OrgUser[];
  roles: Role[];
  teams: Team[];
  permissions: Permission[];
}

/** Shared input styling of the dashboard's forms. */
export const inputCls =
  'w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition';

/** Roles that hold an org-only permission can only be granted org-wide (422 role_not_scopable). */
export function orgOnlyPermissions(role: Role | undefined, data: Pick<AccessData, 'permissions'>): string[] {
  if (!role) return [];
  const scopable = new Map(data.permissions.map((p) => [p.key, p.scopable]));
  return role.permissions.filter((p) => scopable.get(p) !== true);
}

/** The Org Admin role must keep these (engine ORG_ADMIN_LOCKED_PERMISSIONS; 409 last_org_admin otherwise). */
export const ORG_ADMIN_LOCKED = ['rbac.users.manage', 'rbac.roles.manage'];

const CATEGORY_ORDER: PermissionCategory[] = ['org', 'rbac', 'policy', 'case', 'exception', 'audit', 'integration', 'ci'];

/** The permission catalog grouped by category, in a fixed category order, keys sorted within a group. */
export function permissionGroups(permissions: Permission[]): Array<[PermissionCategory, Permission[]]> {
  return CATEGORY_ORDER
    .map((c): [PermissionCategory, Permission[]] => [c, permissions.filter((p) => p.category === c).sort((a, b) => a.key.localeCompare(b.key))])
    .filter(([, ps]) => ps.length > 0);
}

/** The PATCH body for a role edit: only what changed, or null when nothing did. */
export function rolePatch(role: Role, form: { name: string; description: string; permissions: string[] }):
  { name?: string; description?: string; permissions?: string[] } | null {
  const patch: { name?: string; description?: string; permissions?: string[] } = {};
  const name = form.name.trim();
  const description = form.description.trim();
  if (name !== role.name) patch.name = name;
  if (description !== role.description) patch.description = description;
  const before = [...role.permissions].sort();
  const after = [...new Set(form.permissions)].sort();
  if (before.length !== after.length || before.some((p, i) => p !== after[i])) patch.permissions = after;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Team repository patterns from a textarea: one per line, trimmed, blank lines and repeats dropped. */
export function parsePatterns(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

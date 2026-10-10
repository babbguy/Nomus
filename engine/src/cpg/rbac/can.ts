import type { Db } from '../../db/client.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { isScopable } from './catalog.js';
import { compileGlob } from './repo-glob.js';

/**
 * The CPG permission check (design spec §3.3).
 *
 * A permission is held when an active grant exists (not revoked, the user is
 * active and still in the grant's org, the role is not archived) whose role
 * contains it, and either the grant is org-scoped, or the permission is
 * scopable and the grant's repo / team patterns cover `resource.repo`.
 *
 * `users.role` is never consulted: platform_admin gets no implicit CPG
 * permission (§3.4). There is no cross-request cache, so a revocation takes
 * effect on the next request.
 */

export interface EffectiveGrant {
  grantId: string;
  roleId: string;
  roleKey: string;
  permission: string;
  scopeType: 'org' | 'team' | 'repo';
  scopeId: string | null;
  /** Compiled repo patterns of the scoping team (team grants only). */
  teamPatterns: RegExp[];
}

export type Identity = 'session' | 'user_key' | 'org_key';

export interface CpgActor {
  orgId: string;
  userId: string;
  identity: Identity;
  grants: EffectiveGrant[];
}

export interface PermissionResource {
  repo?: string;
}

/** Load every permission a user holds in an org, one row per (grant, permission). */
export function loadEffectiveGrants(db: Db, orgId: string, userId: string): EffectiveGrant[] {
  const sqlite = rawSqlite(db);
  const rows = sqlite.prepare(`
    SELECT ur.id AS grantId, ur.role_id AS roleId, r.key AS roleKey, rp.permission_key AS permission,
           ur.scope_type AS scopeType, ur.scope_id AS scopeId
    FROM cpg_user_roles ur
    JOIN users u ON u.id = ur.user_id AND u.is_active = 1 AND u.org_id = ur.org_id
    JOIN cpg_roles r ON r.id = ur.role_id AND r.org_id = ur.org_id AND r.archived_at IS NULL
    JOIN cpg_role_permissions rp ON rp.role_id = r.id
    WHERE ur.org_id = ? AND ur.user_id = ? AND ur.revoked_at IS NULL
    ORDER BY ur.granted_at, ur.id, rp.permission_key
  `).all(orgId, userId) as Array<Omit<EffectiveGrant, 'teamPatterns'>>;

  const teamIds = [...new Set(rows.filter((r) => r.scopeType === 'team' && r.scopeId).map((r) => r.scopeId as string))];
  const patternsByTeam = new Map<string, RegExp[]>();
  if (teamIds.length > 0) {
    const stmt = sqlite.prepare(`
      SELECT tr.repo_pattern AS pattern FROM cpg_team_repos tr
      JOIN cpg_teams t ON t.id = tr.team_id AND t.org_id = ? AND t.archived_at IS NULL
      WHERE tr.team_id = ?
    `);
    for (const teamId of teamIds) {
      const patterns: RegExp[] = [];
      for (const { pattern } of stmt.all(orgId, teamId) as Array<{ pattern: string }>) {
        // Patterns are validated on write; a pattern that no longer compiles grants nothing.
        try { patterns.push(compileGlob(pattern)); } catch { /* fail closed */ }
      }
      patternsByTeam.set(teamId, patterns);
    }
  }

  return rows.map((r) => ({
    ...r,
    teamPatterns: r.scopeType === 'team' && r.scopeId ? patternsByTeam.get(r.scopeId) ?? [] : [],
  }));
}

/** True when one of the grants carries `permission` for the resource. */
export function can(actor: Pick<CpgActor, 'grants'>, permission: string, resource?: PermissionResource): boolean {
  const repo = resource?.repo;
  for (const g of actor.grants) {
    if (g.permission !== permission) continue;
    if (g.scopeType === 'org') return true;
    // Team and repo grants count only for scopable permissions and only when
    // the request names a repository (§3.3): without one, org grants only.
    if (!isScopable(permission) || !repo) continue;
    if (g.scopeType === 'repo' && g.scopeId === repo) return true;
    if (g.scopeType === 'team' && g.teamPatterns.some((re) => re.test(repo))) return true;
  }
  return false;
}

/** Load the grants and check one permission. */
export function userCan(db: Db, orgId: string, userId: string, permission: string, resource?: PermissionResource): boolean {
  return can({ grants: loadEffectiveGrants(db, orgId, userId) }, permission, resource);
}

/** Distinct {permission, scope, scopeId} triples, for GET /cpg/me. */
export function summarizePermissions(grants: EffectiveGrant[]): Array<{ key: string; scope: 'org' | 'team' | 'repo'; scopeId: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; scope: 'org' | 'team' | 'repo'; scopeId: string | null }> = [];
  for (const g of grants) {
    // A team/repo grant of a non-scopable permission confers nothing; do not advertise it.
    if (g.scopeType !== 'org' && !isScopable(g.permission)) continue;
    const id = `${g.permission}|${g.scopeType}|${g.scopeId ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: g.permission, scope: g.scopeType, scopeId: g.scopeId });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.scope.localeCompare(b.scope) || (a.scopeId ?? '').localeCompare(b.scopeId ?? ''));
}

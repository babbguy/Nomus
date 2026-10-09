import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgRolePermissions, cpgRoles, cpgTeams, cpgUserRoles } from '../../db/schema-cpg.js';
import { users } from '../../db/schema.js';
import { appendAuditEvent } from '../audit/log.js';
import { CpgError, notFound } from '../errors.js';
import { isScopable } from './catalog.js';

/**
 * Role grants (`cpg_user_roles`): creation with every validation from the
 * design spec §3.3/§3.4, revocation (written once) and the last-org-admin
 * guard. Every change writes a `cpg_audit_events` row in the same
 * transaction.
 */

type Db = BetterSQLite3Database<any>;

export type ScopeType = 'org' | 'team' | 'repo';
export type GrantRow = typeof cpgUserRoles.$inferSelect;
export type RoleRow = typeof cpgRoles.$inferSelect;

/** Canonical repository id (§2.2 / §9.3): `owner/name` or `host/owner/name`, lowercase. */
export const CANONICAL_REPO_RE = /^[a-z0-9.-]+(\/[a-z0-9._-]+){1,2}$/;

/** CANONICAL_REPO_RE, minus `.` / `..` segments (never a real owner or repo name). */
export function isCanonicalRepo(repo: string): boolean {
  return repo.length <= 200 && CANONICAL_REPO_RE.test(repo) && !repo.split('/').some((s) => s === '.' || s === '..');
}

export function getRole(db: Db, orgId: string, roleId: string): RoleRow | undefined {
  return db.select().from(cpgRoles).where(and(eq(cpgRoles.id, roleId), eq(cpgRoles.orgId, orgId))).get();
}

export function getRoleByKey(db: Db, orgId: string, key: string): RoleRow | undefined {
  return db.select().from(cpgRoles).where(and(eq(cpgRoles.orgId, orgId), eq(cpgRoles.key, key))).get();
}

export function rolePermissionKeys(db: Db, roleId: string): string[] {
  return db.select({ key: cpgRolePermissions.permissionKey }).from(cpgRolePermissions)
    .where(eq(cpgRolePermissions.roleId, roleId)).all().map((r) => r.key).sort();
}

export function getGrant(db: Db, orgId: string, grantId: string): GrantRow | undefined {
  return db.select().from(cpgUserRoles).where(and(eq(cpgUserRoles.id, grantId), eq(cpgUserRoles.orgId, orgId))).get();
}

function findActiveGrant(db: Db, userId: string, roleId: string, scopeType: ScopeType, scopeId: string | null): GrantRow | undefined {
  return db.select().from(cpgUserRoles).where(and(
    eq(cpgUserRoles.userId, userId),
    eq(cpgUserRoles.roleId, roleId),
    eq(cpgUserRoles.scopeType, scopeType),
    scopeId === null ? isNull(cpgUserRoles.scopeId) : eq(cpgUserRoles.scopeId, scopeId),
    isNull(cpgUserRoles.revokedAt),
  )).get();
}

/**
 * Active org-scoped grants of the system `org_admin` role held by active
 * users of the org (the people who can still administer RBAC).
 */
export function activeOrgAdminGrants(db: Db, orgId: string): Array<{ grantId: string; userId: string }> {
  return rawSqlite(db).prepare(`
    SELECT ur.id AS grantId, ur.user_id AS userId
    FROM cpg_user_roles ur
    JOIN cpg_roles r ON r.id = ur.role_id AND r.is_system = 1 AND r.key = 'org_admin'
    JOIN users u ON u.id = ur.user_id AND u.is_active = 1 AND u.org_id = ur.org_id
    WHERE ur.org_id = ? AND ur.scope_type = 'org' AND ur.revoked_at IS NULL
  `).all(orgId) as Array<{ grantId: string; userId: string }>;
}

/** True when removing `userId`'s admin rights would leave the org with no active Org Admin. */
export function isLastOrgAdmin(db: Db, orgId: string, userId: string): boolean {
  const admins = activeOrgAdminGrants(db, orgId);
  return admins.some((a) => a.userId === userId) && admins.every((a) => a.userId === userId);
}

/** Insert a grant row and its audit event. No validation: callers validate. */
export function insertGrant(db: Db, input: {
  orgId: string; userId: string; role: RoleRow; scopeType: ScopeType; scopeId: string | null; actor: string;
}): GrantRow {
  const row: GrantRow = {
    id: randomUUID(),
    orgId: input.orgId,
    userId: input.userId,
    roleId: input.role.id,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    grantedBy: input.actor,
    grantedAt: new Date().toISOString(),
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  };
  rawSqlite(db).transaction(() => {
    db.insert(cpgUserRoles).values(row).run();
    appendAuditEvent(db, {
      orgId: input.orgId,
      actor: input.actor,
      action: 'grant.created',
      targetType: 'grant',
      targetId: row.id,
      payload: { userId: input.userId, roleId: input.role.id, roleKey: input.role.key, scopeType: input.scopeType, scopeId: input.scopeId },
    });
  })();
  return row;
}

/** Grant a role unless an identical active grant exists. Returns the grant either way. */
export function grantIfMissing(db: Db, input: {
  orgId: string; userId: string; role: RoleRow; scopeType: ScopeType; scopeId: string | null; actor: string;
}): { grant: GrantRow; created: boolean } {
  const existing = findActiveGrant(db, input.userId, input.role.id, input.scopeType, input.scopeId);
  if (existing) return { grant: existing, created: false };
  return { grant: insertGrant(db, input), created: true };
}

export interface CreateGrantInput {
  orgId: string;
  userId: string;
  roleId: string;
  scopeType: ScopeType;
  scopeId?: string | null;
  actor: string;
}

/**
 * Validated grant creation (E10, E18). Idempotent: an identical active grant
 * is returned with created=false instead of a duplicate.
 */
export function createGrant(db: Db, input: CreateGrantInput): { grant: GrantRow; created: boolean } {
  return rawSqlite(db).transaction(() => {
    const user = db.select({ id: users.id, orgId: users.orgId }).from(users).where(eq(users.id, input.userId)).get();
    if (!user || user.orgId !== input.orgId) throw notFound('User');

    const role = getRole(db, input.orgId, input.roleId);
    if (!role) throw notFound('Role');
    if (role.archivedAt) throw new CpgError(409, 'role_archived', 'Archived roles cannot be granted');

    let scopeId: string | null = null;
    if (input.scopeType === 'org') {
      if (input.scopeId !== undefined && input.scopeId !== null) {
        throw new CpgError(400, 'invalid_input', 'scopeId must be omitted for an org-scoped grant');
      }
    } else {
      if (!input.scopeId) throw new CpgError(400, 'invalid_input', `scopeId is required for a ${input.scopeType}-scoped grant`);
      const nonScopable = rolePermissionKeys(db, role.id).filter((p) => !isScopable(p));
      if (nonScopable.length > 0) {
        throw new CpgError(422, 'role_not_scopable', 'This role contains permissions that can only be granted org-wide', { permissions: nonScopable });
      }
      if (input.scopeType === 'team') {
        const team = db.select().from(cpgTeams).where(and(eq(cpgTeams.id, input.scopeId), eq(cpgTeams.orgId, input.orgId))).get();
        if (!team) throw notFound('Team');
        if (team.archivedAt) throw new CpgError(409, 'team_archived', 'Archived teams cannot scope a grant');
        scopeId = team.id;
      } else {
        if (!isCanonicalRepo(input.scopeId)) {
          throw new CpgError(422, 'invalid_repo', 'scopeId must be a canonical lowercase repository id such as owner/name');
        }
        scopeId = input.scopeId;
      }
    }

    return grantIfMissing(db, { orgId: input.orgId, userId: user.id, role, scopeType: input.scopeType, scopeId, actor: input.actor });
  })();
}

/** Revoke a grant (E11). The revocation columns are written exactly once. */
export function revokeGrant(db: Db, input: { orgId: string; grantId: string; actor: string; reason: string }): GrantRow {
  return rawSqlite(db).transaction(() => {
    const grant = getGrant(db, input.orgId, input.grantId);
    if (!grant) throw notFound('Grant');
    if (grant.revokedAt) throw new CpgError(409, 'grant_already_revoked', 'This grant has already been revoked');

    const role = getRole(db, input.orgId, grant.roleId);
    if (role?.isSystem && role.key === 'org_admin' && grant.scopeType === 'org') {
      const others = activeOrgAdminGrants(db, input.orgId).filter((a) => a.grantId !== grant.id);
      if (others.length === 0) {
        throw new CpgError(409, 'last_org_admin', 'The organization must keep at least one active Org Admin');
      }
    }

    return writeRevocation(db, grant, role?.key ?? null, input.actor, input.reason);
  })();
}

function writeRevocation(db: Db, grant: GrantRow, roleKey: string | null, actor: string, reason: string): GrantRow {
  const now = new Date().toISOString();
  db.update(cpgUserRoles)
    .set({ revokedAt: now, revokedBy: actor, revokeReason: reason })
    .where(and(eq(cpgUserRoles.id, grant.id), isNull(cpgUserRoles.revokedAt)))
    .run();
  appendAuditEvent(db, {
    orgId: grant.orgId,
    actor,
    action: 'grant.revoked',
    targetType: 'grant',
    targetId: grant.id,
    payload: { userId: grant.userId, roleId: grant.roleId, roleKey, scopeType: grant.scopeType, scopeId: grant.scopeId, reason },
  });
  return { ...grant, revokedAt: now, revokedBy: actor, revokeReason: reason };
}

/**
 * Revoke every active grant a user holds in an org (user moved to another
 * org, §3.5). Deliberately bypasses the last-org-admin guard: only a platform
 * admin can move users, and E18 is the recovery path.
 */
export function revokeAllGrantsInOrg(db: Db, orgId: string, userId: string, actor: string, reason: string): number {
  return rawSqlite(db).transaction(() => {
    const active = db.select().from(cpgUserRoles).where(and(
      eq(cpgUserRoles.orgId, orgId), eq(cpgUserRoles.userId, userId), isNull(cpgUserRoles.revokedAt),
    )).all();
    for (const g of active) writeRevocation(db, g, getRole(db, orgId, g.roleId)?.key ?? null, actor, reason);
    return active.length;
  })();
}

export function listUserGrants(db: Db, orgId: string, userId: string, includeRevoked = false): GrantRow[] {
  const rows = db.select().from(cpgUserRoles)
    .where(and(eq(cpgUserRoles.orgId, orgId), eq(cpgUserRoles.userId, userId)))
    .all();
  return (includeRevoked ? rows : rows.filter((g) => !g.revokedAt))
    .sort((a, b) => a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
}

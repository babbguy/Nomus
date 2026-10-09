import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AppEnv } from '../../app.js';
import { getDb } from '../../../db/client.js';
import { rawSqlite } from '../../../db/migrations/runner.js';
import { organizations, users } from '../../../db/schema.js';
import { cpgPermissions, cpgRolePermissions, cpgRoles, cpgTeamRepos, cpgTeams, cpgUserRoles } from '../../../db/schema-cpg.js';
import { requireSessionOrApiKey } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireCpgPermission } from '../../../cpg/rbac/middleware.js';
import { ORG_ADMIN_LOCKED_PERMISSIONS, isScopable, type PermissionKey } from '../../../cpg/rbac/catalog.js';
import {
  createGrant, getRole, getRoleByKey, grantIfMissing, isLastOrgAdmin, revokeGrant, rolePermissionKeys,
} from '../../../cpg/rbac/grants.js';
import { applyNewMemberGrants } from '../../../cpg/rbac/seed.js';
import { repoPatternError } from '../../../cpg/rbac/repo-glob.js';
import { appendAuditEvent } from '../../../cpg/audit/log.js';
import {
  createGrantRequestSchema, createRoleRequestSchema, createTeamRequestSchema, createUserRequestSchema, emptyRequestSchema,
  grantResponseSchema, listOf, orgUserResponseSchema, patchRoleRequestSchema, patchTeamRequestSchema, patchUserRequestSchema,
  permissionResponseSchema, revokeGrantRequestSchema, roleResponseSchema, serializeGrant, serializeOrgUser, serializeRole,
  serializeTeam, teamResponseSchema,
} from '../../../cpg/contracts.js';
import { CpgError, notFound } from '../../../cpg/errors.js';
import { invitationMessage, makeTemporaryPassword, sendInvitationEmail } from '../../../services/invitations.js';
import { logger } from '../../../logger.js';
import { actorFrom, auditActor, handle, parseBody, pathParam } from './helpers.js';

/**
 * Org-scoped RBAC (design spec §3, endpoints E2 to E14): the permission
 * catalog, roles, org users and their grants, and teams. Browser sessions
 * only. Cross-org ids are always 404, never 403.
 */
export const cpgRbacRoutes = new Hono<AppEnv>();

type Db = BetterSQLite3Database<any>;

const session = (permission: PermissionKey) => [requireSessionOrApiKey(), rateLimit(), requireCpgPermission(permission)] as const;

// ─── E2 permissions ────────────────────────────────────────────────────

cpgRbacRoutes.get('/permissions', ...session('org.members.read'), handle((c) => {
  const items = getDb().select().from(cpgPermissions).orderBy(asc(cpgPermissions.key)).all()
    .map((p) => ({ key: p.key, category: p.category, scopable: p.scopable, description: p.description }));
  return c.json(listOf(permissionResponseSchema).parse({ items }));
}));

// ─── E3–E6 roles ───────────────────────────────────────────────────────

cpgRbacRoutes.get('/roles', ...session('org.members.read'), handle((c) => {
  const db = getDb();
  const items = db.select().from(cpgRoles)
    .where(eq(cpgRoles.orgId, actorFrom(c).orgId))
    .orderBy(desc(cpgRoles.isSystem), asc(cpgRoles.key))
    .all()
    .map((r) => serializeRole(db, r));
  return c.json(listOf(roleResponseSchema).parse({ items }));
}));

cpgRbacRoutes.post('/roles', ...session('rbac.roles.manage'), handle(async (c) => {
  const body = await parseBody(c, createRoleRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const role = rawSqlite(db).transaction(() => {
    if (getRoleByKey(db, orgId, body.key)) throw new CpgError(409, 'role_key_taken', `A role with key "${body.key}" already exists`);
    const row = {
      id: randomUUID(), orgId, key: body.key, name: body.name, description: body.description ?? '',
      isSystem: false, createdBy: actor, createdAt: new Date().toISOString(), archivedAt: null, archivedBy: null,
    };
    db.insert(cpgRoles).values(row).run();
    for (const permissionKey of body.permissions) db.insert(cpgRolePermissions).values({ roleId: row.id, permissionKey }).run();
    appendAuditEvent(db, {
      orgId, actor, action: 'role.created', targetType: 'role', targetId: row.id,
      payload: { key: row.key, name: row.name, permissions: [...body.permissions].sort() },
    });
    return row;
  })();
  return c.json(roleResponseSchema.parse(serializeRole(db, role)), 201);
}));

/** Active team- or repo-scoped grants of a role (they forbid adding non-scopable permissions). */
function hasScopedGrants(db: Db, roleId: string): boolean {
  return db.select({ id: cpgUserRoles.id, revokedAt: cpgUserRoles.revokedAt, scopeType: cpgUserRoles.scopeType })
    .from(cpgUserRoles).where(eq(cpgUserRoles.roleId, roleId)).all()
    .some((g) => !g.revokedAt && g.scopeType !== 'org');
}

cpgRbacRoutes.patch('/roles/:id', ...session('rbac.roles.manage'), handle(async (c) => {
  const body = await parseBody(c, patchRoleRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const roleId = pathParam(c, 'id');
  const updated = rawSqlite(db).transaction(() => {
    const role = getRole(db, orgId, roleId);
    if (!role) throw notFound('Role');
    if (role.archivedAt) throw new CpgError(409, 'role_archived', 'Archived roles cannot be edited');

    if (body.permissions !== undefined) {
      const before = rolePermissionKeys(db, role.id);
      const after = [...new Set(body.permissions)].sort();
      if (role.isSystem && role.key === 'org_admin') {
        const lost = ORG_ADMIN_LOCKED_PERMISSIONS.filter((p) => !after.includes(p));
        if (lost.length > 0) {
          throw new CpgError(409, 'last_org_admin', 'The Org Admin role must keep rbac.users.manage and rbac.roles.manage', { permissions: lost });
        }
      }
      const nonScopable = after.filter((p) => !isScopable(p));
      if (nonScopable.length > 0 && hasScopedGrants(db, role.id)) {
        throw new CpgError(422, 'role_not_scopable', 'This role has team- or repo-scoped grants, so it can only hold scopable permissions', { permissions: nonScopable });
      }
      const removed = before.filter((p) => !after.includes(p));
      const added = after.filter((p) => !before.includes(p));
      for (const p of removed) {
        db.delete(cpgRolePermissions).where(and(eq(cpgRolePermissions.roleId, role.id), eq(cpgRolePermissions.permissionKey, p))).run();
      }
      for (const p of added) db.insert(cpgRolePermissions).values({ roleId: role.id, permissionKey: p }).run();
      if (removed.length > 0 || added.length > 0) {
        appendAuditEvent(db, {
          orgId, actor, action: 'role.permissions_changed', targetType: 'role', targetId: role.id,
          payload: { key: role.key, before, after, added, removed },
        });
      }
    }

    const name = body.name ?? role.name;
    const description = body.description ?? role.description;
    if (name !== role.name || description !== role.description) {
      db.update(cpgRoles).set({ name, description }).where(eq(cpgRoles.id, role.id)).run();
      appendAuditEvent(db, {
        orgId, actor, action: 'role.updated', targetType: 'role', targetId: role.id,
        payload: { key: role.key, before: { name: role.name, description: role.description }, after: { name, description } },
      });
    }
    return getRole(db, orgId, role.id)!;
  })();
  return c.json(roleResponseSchema.parse(serializeRole(db, updated)));
}));

cpgRbacRoutes.post('/roles/:id/archive', ...session('rbac.roles.manage'), handle(async (c) => {
  await parseBody(c, emptyRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const roleId = pathParam(c, 'id');
  const archived = rawSqlite(db).transaction(() => {
    const role = getRole(db, orgId, roleId);
    if (!role) throw notFound('Role');
    if (role.isSystem) throw new CpgError(403, 'forbidden', 'System roles cannot be archived', { reason: 'system_role' });
    if (role.archivedAt) return role;
    db.update(cpgRoles).set({ archivedAt: new Date().toISOString(), archivedBy: actor }).where(eq(cpgRoles.id, role.id)).run();
    appendAuditEvent(db, { orgId, actor, action: 'role.archived', targetType: 'role', targetId: role.id, payload: { key: role.key } });
    return getRole(db, orgId, role.id)!;
  })();
  return c.json(roleResponseSchema.parse(serializeRole(db, archived)));
}));

// ─── E7–E11 users and grants ───────────────────────────────────────────

const userColumns = {
  id: users.id, name: users.name, email: users.email, isActive: users.isActive,
  mustChangePassword: users.mustChangePassword, role: users.role, orgId: users.orgId,
};

function orgUser(db: Db, orgId: string, userId: string) {
  const u = db.select(userColumns).from(users).where(eq(users.id, userId)).get();
  if (!u || u.orgId !== orgId) throw notFound('User');
  return u;
}

cpgRbacRoutes.get('/users', ...session('org.members.read'), handle((c) => {
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const items = db.select(userColumns).from(users)
    .where(eq(users.orgId, orgId))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all()
    .map((u) => serializeOrgUser(db, orgId, u));
  return c.json(listOf(orgUserResponseSchema).parse({ items }));
}));

cpgRbacRoutes.post('/users', ...session('rbac.users.manage'), handle(async (c) => {
  const body = await parseBody(c, createUserRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const email = body.email.toLowerCase().trim();

  if (db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
    throw new CpgError(409, 'email_in_use', 'Email already in use');
  }
  const roleKeys = [...new Set(body.roleKeys ?? [])];
  const roles = roleKeys.map((k) => ({ key: k, role: getRoleByKey(db, orgId, k) }));
  const unknown = roles.filter((r) => !r.role || r.role.archivedAt).map((r) => r.key);
  if (unknown.length > 0) throw new CpgError(400, 'invalid_input', 'Unknown or archived role keys', { roleKeys: unknown });

  // Hash outside the write transaction (bcrypt is slow and async).
  const { tempPassword, passwordHash } = await makeTemporaryPassword();
  const now = new Date().toISOString();
  const userId = randomUUID();
  rawSqlite(db).transaction(() => {
    // Re-check inside the transaction: the email is UNIQUE.
    if (db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
      throw new CpgError(409, 'email_in_use', 'Email already in use');
    }
    db.insert(users).values({
      id: userId, orgId, email, passwordHash, name: body.name, role: 'member', authProvider: 'local',
      mustChangePassword: true, isActive: true, createdAt: now, updatedAt: now,
    }).run();
    appendAuditEvent(db, {
      orgId, actor, action: 'user.invited', targetType: 'user', targetId: userId, payload: { roleKeys },
    });
    applyNewMemberGrants(db, orgId, userId, actor);
    for (const { role } of roles) {
      grantIfMissing(db, { orgId, userId, role: role!, scopeType: 'org', scopeId: null, actor });
    }
  })();

  const orgName = db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get()?.name ?? null;
  sendInvitationEmail({ email, tempPassword, orgName });
  logger.info({ orgId, userId, actor, message: invitationMessage() }, 'Org user invited');

  const user = serializeOrgUser(db, orgId, orgUser(db, orgId, userId));
  return c.json({ user: orgUserResponseSchema.parse(user), tempPassword }, 201);
}));

cpgRbacRoutes.patch('/users/:id', ...session('rbac.users.manage'), handle(async (c) => {
  const body = await parseBody(c, patchUserRequestSchema);
  const db = getDb();
  const actorInfo = actorFrom(c);
  const orgId = actorInfo.orgId;
  const actor = auditActor(c);
  const userId = pathParam(c, 'id');
  rawSqlite(db).transaction(() => {
    const target = orgUser(db, orgId, userId);
    if (target.role === 'platform_admin') {
      throw new CpgError(403, 'forbidden', 'Platform administrators are managed by the platform operator', { reason: 'platform_admin' });
    }
    if (body.isActive === false && target.isActive) {
      if (target.id === actorInfo.userId) throw new CpgError(409, 'cannot_deactivate_self', 'You cannot deactivate your own account');
      if (isLastOrgAdmin(db, orgId, target.id)) {
        throw new CpgError(409, 'last_org_admin', 'The organization must keep at least one active Org Admin');
      }
    }
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (body.name !== undefined && body.name !== target.name) changes.name = { before: target.name, after: body.name };
    if (body.isActive !== undefined && body.isActive !== target.isActive) changes.isActive = { before: target.isActive, after: body.isActive };
    if (Object.keys(changes).length === 0) return;
    db.update(users).set({
      ...(changes.name ? { name: body.name } : {}),
      ...(changes.isActive ? { isActive: body.isActive } : {}),
      updatedAt: new Date().toISOString(),
    }).where(eq(users.id, target.id)).run();
    appendAuditEvent(db, { orgId, actor, action: 'user.updated', targetType: 'user', targetId: target.id, payload: { changes } });
  })();
  return c.json(orgUserResponseSchema.parse(serializeOrgUser(db, orgId, orgUser(db, orgId, userId))));
}));

cpgRbacRoutes.post('/users/:id/grants', ...session('rbac.users.manage'), handle(async (c) => {
  const body = await parseBody(c, createGrantRequestSchema);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const { grant, created } = createGrant(db, {
    orgId, userId: pathParam(c, 'id'), roleId: body.roleId, scopeType: body.scopeType, scopeId: body.scopeId ?? null, actor: auditActor(c),
  });
  return c.json(grantResponseSchema.parse(serializeGrant(db, grant)), created ? 201 : 200);
}));

cpgRbacRoutes.post('/grants/:id/revoke', ...session('rbac.users.manage'), handle(async (c) => {
  const body = await parseBody(c, revokeGrantRequestSchema);
  const db = getDb();
  const grant = revokeGrant(db, { orgId: actorFrom(c).orgId, grantId: pathParam(c, 'id'), actor: auditActor(c), reason: body.reason });
  return c.json(grantResponseSchema.parse(serializeGrant(db, grant)));
}));

// ─── E12–E14 teams ─────────────────────────────────────────────────────

function validatePatterns(patterns: string[]): void {
  const errors = patterns.map((p) => repoPatternError(p)).filter((e): e is string => e !== null);
  if (errors.length > 0) throw new CpgError(422, 'invalid_glob', 'Invalid repository pattern', { errors });
}

function getTeam(db: Db, orgId: string, teamId: string) {
  const team = db.select().from(cpgTeams).where(and(eq(cpgTeams.id, teamId), eq(cpgTeams.orgId, orgId))).get();
  if (!team) throw notFound('Team');
  return team;
}

cpgRbacRoutes.get('/teams', ...session('org.members.read'), handle((c) => {
  const db = getDb();
  const items = db.select().from(cpgTeams)
    .where(eq(cpgTeams.orgId, actorFrom(c).orgId))
    .orderBy(asc(cpgTeams.key))
    .all()
    .map((t) => serializeTeam(db, t));
  return c.json(listOf(teamResponseSchema).parse({ items }));
}));

cpgRbacRoutes.post('/teams', ...session('rbac.teams.manage'), handle(async (c) => {
  const body = await parseBody(c, createTeamRequestSchema);
  validatePatterns(body.repoPatterns);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const team = rawSqlite(db).transaction(() => {
    if (db.select({ id: cpgTeams.id }).from(cpgTeams).where(and(eq(cpgTeams.orgId, orgId), eq(cpgTeams.key, body.key))).get()) {
      throw new CpgError(409, 'team_key_taken', `A team with key "${body.key}" already exists`);
    }
    const now = new Date().toISOString();
    const row = { id: randomUUID(), orgId, key: body.key, name: body.name, createdBy: actor, createdAt: now, archivedAt: null };
    db.insert(cpgTeams).values(row).run();
    for (const repoPattern of body.repoPatterns) {
      db.insert(cpgTeamRepos).values({ teamId: row.id, repoPattern, addedBy: actor, addedAt: now }).run();
    }
    appendAuditEvent(db, {
      orgId, actor, action: 'team.created', targetType: 'team', targetId: row.id,
      payload: { key: row.key, name: row.name, repoPatterns: [...body.repoPatterns].sort() },
    });
    return row;
  })();
  return c.json(teamResponseSchema.parse(serializeTeam(db, team)), 201);
}));

cpgRbacRoutes.patch('/teams/:id', ...session('rbac.teams.manage'), handle(async (c) => {
  const body = await parseBody(c, patchTeamRequestSchema);
  if (body.repoPatterns) validatePatterns(body.repoPatterns);
  const db = getDb();
  const orgId = actorFrom(c).orgId;
  const actor = auditActor(c);
  const teamId = pathParam(c, 'id');
  rawSqlite(db).transaction(() => {
    const team = getTeam(db, orgId, teamId);
    const now = new Date().toISOString();
    const beforePatterns = serializeTeam(db, team).repoPatterns;
    const payload: Record<string, unknown> = { key: team.key };

    if (body.repoPatterns) {
      const after = [...body.repoPatterns].sort();
      const removed = beforePatterns.filter((p) => !after.includes(p));
      const added = after.filter((p) => !beforePatterns.includes(p));
      for (const p of removed) {
        db.delete(cpgTeamRepos).where(and(eq(cpgTeamRepos.teamId, team.id), eq(cpgTeamRepos.repoPattern, p))).run();
      }
      for (const p of added) db.insert(cpgTeamRepos).values({ teamId: team.id, repoPattern: p, addedBy: actor, addedAt: now }).run();
      if (removed.length > 0 || added.length > 0) payload.repoPatterns = { before: beforePatterns, after };
    }
    const name = body.name ?? team.name;
    const archivedAt = body.archived === undefined ? team.archivedAt : body.archived ? (team.archivedAt ?? now) : null;
    if (name !== team.name) payload.name = { before: team.name, after: name };
    if (archivedAt !== team.archivedAt) payload.archived = { before: team.archivedAt !== null, after: archivedAt !== null };
    if (name !== team.name || archivedAt !== team.archivedAt) {
      db.update(cpgTeams).set({ name, archivedAt }).where(eq(cpgTeams.id, team.id)).run();
    }
    if (Object.keys(payload).length > 1) {
      appendAuditEvent(db, { orgId, actor, action: 'team.updated', targetType: 'team', targetId: team.id, payload });
    }
  })();
  return c.json(teamResponseSchema.parse(serializeTeam(db, getTeam(db, orgId, teamId))));
}));

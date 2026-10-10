import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { rawSqlite } from '../../db/migrations/runner.js';
import { cpgOrgSettings, cpgPermissions, cpgRolePermissions, cpgRoles } from '../../db/schema-cpg.js';
import { organizations, users } from '../../db/schema.js';
import { isLlmProviderConfigured } from '../../llm/provider.js';
import { appendAuditEvent } from '../audit/log.js';
import { PERMISSIONS, SYSTEM_ROLES, type SystemRoleKey } from './catalog.js';
import { activeOrgAdminGrants, getRoleByKey, grantIfMissing, type RoleRow } from './grants.js';

/**
 * RBAC seeding and the one-time migration of v1.1.0 users (design spec §3.5).
 *
 * For each organization:
 *   1. the seven system roles exist (insert-if-missing by (org_id, key), so
 *      an Org Admin's edits to a system role's permissions are kept);
 *   2. a cpg_org_settings row exists with enabled = 0;
 *   3. once (rbac_migrated_at IS NULL): the earliest member becomes Org Admin
 *      and Developer, every other member becomes Developer, platform admins
 *      get nothing.
 */

export const SEED_ACTOR = 'system:seed';
export const MIGRATION_ACTOR = 'system:rbac-migration';

/** INSERT OR IGNORE the permission catalog (append-only: it only ever grows). */
export function ensurePermissionCatalog(db: Db): void {
  rawSqlite(db).transaction(() => {
    for (const p of PERMISSIONS) {
      db.insert(cpgPermissions).values({ key: p.key, category: p.category, scopable: p.scopable, description: p.description })
        .onConflictDoNothing().run();
    }
  })();
}

function ensureSystemRoles(db: Db, orgId: string): string[] {
  const created: string[] = [];
  for (const def of SYSTEM_ROLES) {
    if (getRoleByKey(db, orgId, def.key)) continue;
    const id = randomUUID();
    db.insert(cpgRoles).values({
      id, orgId, key: def.key, name: def.name, description: def.description,
      isSystem: true, createdBy: SEED_ACTOR, createdAt: new Date().toISOString(), archivedAt: null, archivedBy: null,
    }).run();
    for (const permissionKey of def.permissions) {
      db.insert(cpgRolePermissions).values({ roleId: id, permissionKey }).run();
    }
    created.push(def.key);
  }
  return created;
}

function systemRole(db: Db, orgId: string, key: SystemRoleKey): RoleRow {
  const role = getRoleByKey(db, orgId, key);
  if (!role || !role.isSystem) throw new Error(`System role ${key} missing for org ${orgId}`);
  return role;
}

/** The org owner (§3.5): the earliest active member, else the earliest inactive one. */
export function selectOwner(db: Db, orgId: string): { id: string; isActive: boolean } | null {
  const members = db.select({ id: users.id, isActive: users.isActive }).from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, 'member')))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all();
  return members.find((m) => m.isActive) ?? members[0] ?? null;
}

export function getOrgSettings(db: Db, orgId: string) {
  return db.select().from(cpgOrgSettings).where(eq(cpgOrgSettings.orgId, orgId)).get();
}

/**
 * Bring one org's RBAC up to date. Idempotent and cheap after the first call.
 * Runs in a (nested-safe) transaction.
 */
export function ensureOrgRbac(db: Db, orgId: string): { migrated: boolean } {
  return rawSqlite(db).transaction(() => {
    const createdRoles = ensureSystemRoles(db, orgId);
    if (createdRoles.length > 0) {
      appendAuditEvent(db, {
        orgId, actor: SEED_ACTOR, action: 'rbac.roles_seeded', targetType: 'org', targetId: orgId,
        payload: { roleKeys: createdRoles },
      });
    }

    let settings = getOrgSettings(db, orgId);
    if (!settings) {
      const now = new Date().toISOString();
      // Owner decision D1: reviewer-context generation defaults on when the
      // instance has an LLM provider configured; an Org Admin can turn it off.
      const reviewerContextLlm = isLlmProviderConfigured('translator');
      db.insert(cpgOrgSettings).values({
        orgId, enabled: false, reviewerContextLlm, rbacMigratedAt: null, updatedBy: SEED_ACTOR, updatedAt: now,
      }).run();
      appendAuditEvent(db, {
        orgId, actor: SEED_ACTOR, action: 'settings.initialized', targetType: 'settings', targetId: orgId,
        payload: { enabled: false, reviewerContextLlm },
      });
      settings = getOrgSettings(db, orgId)!;
    }

    if (settings.rbacMigratedAt) return { migrated: false };

    const owner = selectOwner(db, orgId);
    const developer = systemRole(db, orgId, 'developer');
    const orgAdmin = systemRole(db, orgId, 'org_admin');
    if (owner) {
      grantIfMissing(db, { orgId, userId: owner.id, role: orgAdmin, scopeType: 'org', scopeId: null, actor: MIGRATION_ACTOR });
    }
    const members = db.select({ id: users.id }).from(users)
      .where(and(eq(users.orgId, orgId), eq(users.role, 'member'))).all();
    for (const m of members) {
      grantIfMissing(db, { orgId, userId: m.id, role: developer, scopeType: 'org', scopeId: null, actor: MIGRATION_ACTOR });
    }

    const now = new Date().toISOString();
    db.update(cpgOrgSettings).set({ rbacMigratedAt: now }).where(eq(cpgOrgSettings.orgId, orgId)).run();
    appendAuditEvent(db, {
      orgId, actor: MIGRATION_ACTOR, action: 'rbac.migrated', targetType: 'org', targetId: orgId,
      payload: { ownerUserId: owner?.id ?? null, developerCount: members.length },
    });
    return { migrated: true };
  })();
}

/** True once the org has been seeded and migrated (fast path for request middleware). */
export function isOrgRbacReady(db: Db, orgId: string): boolean {
  return !!getOrgSettings(db, orgId)?.rbacMigratedAt;
}

/** Seed the catalog and every organization. Called on every start. */
export function seedCpgRbac(db: Db): { orgs: number; migrated: number } {
  ensurePermissionCatalog(db);
  const orgs = db.select({ id: organizations.id }).from(organizations).all();
  let migrated = 0;
  for (const o of orgs) if (ensureOrgRbac(db, o.id).migrated) migrated++;
  return { orgs: orgs.length, migrated };
}

/**
 * Grants for a newly created (or newly moved-in) member (§3.5): Developer,
 * plus Org Admin when the org has no active Org Admin ("first org owner").
 * Platform admins get nothing. Call inside the transaction that created the user.
 */
export function applyNewMemberGrants(db: Db, orgId: string, userId: string, actor: string): void {
  rawSqlite(db).transaction(() => {
    ensureOrgRbac(db, orgId);
    const user = db.select({ role: users.role, orgId: users.orgId }).from(users).where(eq(users.id, userId)).get();
    if (!user || user.orgId !== orgId || user.role !== 'member') return;
    grantIfMissing(db, { orgId, userId, role: systemRole(db, orgId, 'developer'), scopeType: 'org', scopeId: null, actor });
    if (activeOrgAdminGrants(db, orgId).length === 0) {
      grantIfMissing(db, { orgId, userId, role: systemRole(db, orgId, 'org_admin'), scopeType: 'org', scopeId: null, actor });
    }
  })();
}

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../../server/app.js';
import { getDb } from '../../db/client.js';
import { cpgError } from '../errors.js';
import { can, loadEffectiveGrants, type CpgActor, type Identity, type PermissionResource } from './can.js';
import type { PermissionKey } from './catalog.js';
import { ensureOrgRbac, isOrgRbacReady } from './seed.js';

/**
 * Permission middleware for CPG routes (design spec §9.1). Mount it AFTER
 * requireSessionOrApiKey(...) and rateLimit(), so the temporary-password
 * block (403 password_change_required) always fires before any permission
 * check (§3.7).
 */

export function identityOf(c: Context<AppEnv>): Identity {
  const identity = c.get('identity');
  if (identity) return identity;
  return c.get('userId') ? 'session' : 'org_key';
}

/**
 * The calling user's CPG identity and effective grants, computed once per
 * request and cached in the context. Orgs that predate CPG (or were created
 * outside the seeding paths) are seeded and migrated on first use.
 */
export function loadCpgActor(c: Context<AppEnv>): CpgActor | null {
  const cached = c.get('cpgActor');
  if (cached) return cached;
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) return null;
  const db = getDb();
  if (!isOrgRbacReady(db, orgId)) ensureOrgRbac(db, orgId);
  const actor: CpgActor = { orgId, userId, identity: identityOf(c), grants: loadEffectiveGrants(db, orgId, userId) };
  c.set('cpgActor', actor);
  return actor;
}

export interface CpgPermissionOptions {
  /** Accept a user-bound API key (the "UK" auth in the endpoint table). Default: sessions only. */
  allowUserKey?: boolean;
  /** Accept an org API key (the "K[scope]" auth): the handler then has no CPG actor and authorizes by the key's org. */
  allowOrgKey?: boolean;
  /** Derive the repository the request concerns, for team/repo-scoped grants. */
  resource?: (c: Context<AppEnv>) => PermissionResource | undefined;
}

/**
 * Require a CPG permission. `null` requires only a user identity (GET /cpg/me).
 * Org API keys carry no user, so they get 403 user_identity_required unless
 * the route allows them (`allowOrgKey`, read-only routes the CI action uses).
 */
export function requireCpgPermission(permission: PermissionKey | null, opts: CpgPermissionOptions = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const identity = identityOf(c);
    if (identity === 'org_key') {
      if (opts.allowOrgKey) return next();
      return cpgError(c, 403, 'user_identity_required', 'This endpoint acts on behalf of a user; sign in or use a user-bound key');
    }
    if (identity === 'user_key' && !opts.allowUserKey) {
      return cpgError(c, 403, 'forbidden', 'This endpoint requires a browser session', { permission, reason: 'session_required' });
    }
    const actor = loadCpgActor(c);
    if (!actor) return cpgError(c, 401, 'unauthenticated', 'Authentication required');
    if (permission && !can(actor, permission, opts.resource?.(c))) {
      return cpgError(c, 403, 'forbidden', `Missing permission ${permission}`, { permission });
    }
    await next();
  });
}

/**
 * Permission check for the legacy self-service routes under /api/v1/org
 * (§3.8). A platform_admin session keeps its v1.1.0 access there, mirroring
 * requireSession's rule; nowhere else does platform_admin imply a CPG
 * permission (§3.4).
 */
export function requireOrgPermission(permission: PermissionKey) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('userRole') === 'platform_admin') {
      await next();
      return;
    }
    const actor = loadCpgActor(c);
    if (!actor) return cpgError(c, 401, 'unauthenticated', 'Authentication required');
    if (!can(actor, permission)) {
      return cpgError(c, 403, 'forbidden', `Missing permission ${permission}`, { permission });
    }
    await next();
  });
}
